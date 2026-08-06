#!/usr/bin/env node
/**
 * TRA-3011 — grade the /data GROWTH SOURCE on the axis that actually ran out: INODES.
 *
 * TRA-3011's first half (the served free-space watermark, `00a8cbb`) is live. This is
 * the second half: proving whether the thing that filled `/data` is now BOUNDED, on a
 * measured series rather than the hypothesis "TRA-2817's prune is live, so it must be".
 *
 * ## Why inodes and not bytes
 *
 * The 07-31→08-04 outage was never a byte shortage. At the last ENOSPC line the volume
 * held 383 MB free of 1 GB (`freePct 37.6`) and **65,524 of 65,536 inodes consumed**.
 * Every byte figure on every surface read healthy for the whole six days. Grading bytes
 * here reproduces the exact blind spot the ticket was filed about, so this script grades
 * `inodesTotal - inodesFree` and attributes it with the per-entry `files + dirs` counts
 * from the same walk.
 *
 * ## Why the WALK and not the WATERMARK
 *
 * `disk.watermark.inodeFreePctMin` is the obvious series to trend and it is the wrong
 * one. Every `*Min` / `*Seen` field on it is **since-boot** by construction (that is the
 * honest design — see TRA-3011's watermark), and bqb1 reboots several times a day. A
 * post-session read of `inodeFreePctMin` therefore reports the worst reading since the
 * last boot, which may be minutes old: a box that filled up at 15:00Z and rebooted at
 * 19:00Z publishes a pristine minimum at 20:30Z. The watermark is the ALARM. The walk —
 * `usage.entries[].files/dirs`, a live stat of the filesystem with no since-boot state —
 * is the TREND. This script grades the walk and prints the watermark only as coverage
 * context, explicitly refusing to compare minima across a boot change.
 *
 * ## Every failure mode here reads like an answer
 *
 *   - **Overnight flatness.** `/data` growth is trading-day shaped. Two samples six
 *     hours apart at 02:00Z and 08:00Z show ~zero growth on a box that is filling fast
 *     during RTH. A window with no RTH overlap is exit 4 PARTIAL, never BOUNDED.
 *   - **A single sample.** One reading has no rate. The structural checks below still
 *     run on it (they are single-sample by construction), but a trend verdict off one
 *     point is exit 4, never 0.
 *   - **Not deployed.** A build predating `00a8cbb` answers 200 on this route with no
 *     `disk.watermark`; one predating TRA-2420 has no `usage`. Both read as "small
 *     number" downstream. Exit 2, distinct from BLIND.
 *   - **No inode table.** A filesystem that declines publishes `inodesTotal: null`.
 *     That is exit 3 BLIND — NOT a synthesised 100% free, which is what the pre-TRA-2817
 *     alarm effectively assumed and why it could not fire for the whole outage.
 *   - **An incomplete walk.** `truncated`, a non-empty `errors[]`, or a walk that does
 *     not reconcile against statvfs means the attribution is a FLOOR. A floor cannot
 *     clear a named writer, so it is exit 6 UNATTRIBUTED, not a pass.
 *   - **A bounded writer measured mid-cycle.** `backups/` oscillates: TRA-2817's
 *     `pruneBackupsToBudget` lets it climb one generation (~1.6k files) then cuts it.
 *     Two samples straddling a climb show growth; two straddling a prune show a fall.
 *     Neither is the bound. The bound is `files <= maxFiles`, which is checked
 *     structurally on EVERY sample, independent of the window.
 *
 * ## Exit codes
 *   0  BOUNDED        graded window: no writer is on track to exhaust the inode table
 *   1  UNBOUNDED      a named writer is over budget, or the net rate exhausts inodes
 *                     inside the horizon
 *   2  NOT_DEPLOYED   200 without `usage` / `disk.watermark` — the old build
 *   3  BLIND          unreachable, non-200, unparseable, or no inode table
 *   4  PARTIAL        measured, but the window cannot carry a trend verdict
 *   5  NO_TOKEN       no admin token supplied, or the host rejected it
 *   6  UNATTRIBUTED   the walk does not account for the used inodes
 *
 * ## Usage
 *   TRADING_ADMIN_TOKEN=… node scripts/tra3011-inode-growth.mjs --sample   # append one reading
 *   TRADING_ADMIN_TOKEN=… node scripts/tra3011-inode-growth.mjs            # sample + grade window
 *   node scripts/tra3011-inode-growth.mjs --grade-only                     # grade the stored series
 *   node scripts/tra3011-inode-growth.mjs --self-test                      # no token needed
 *
 * Options: --host= --series= --min-rth-minutes=240 --min-horizon-days=90
 *          --max-residual-pct=5 --backups-max-files=8000 --token=
 */

import { readFileSync, appendFileSync, existsSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const flag = (name) => argv.includes(`--${name}`);

const HOST = arg('host') ?? 'https://tradingai-bqb1.onrender.com';
const SERIES = arg('series') ?? 'docs/tra3011-inode-series.jsonl';
const MIN_RTH_MINUTES = Number(arg('min-rth-minutes') ?? '240');
const MIN_HORIZON_DAYS = Number(arg('min-horizon-days') ?? '90');
const MAX_RESIDUAL_PCT = Number(arg('max-residual-pct') ?? '5');
// TRA-2817's own budget. Read from the walk, not from a config file, because the
// number that matters is what the prune is ACHIEVING on the live box.
const BACKUPS_MAX_FILES = Number(arg('backups-max-files') ?? '8000');

const TOKEN = (
  arg('token') ??
  process.env['TRADING_ADMIN_TOKEN'] ??
  process.env['TRADINGAI_ADMIN_TOKEN'] ??
  process.env['ADMIN_TOKEN'] ??
  ''
).trim();

const EXIT = {
  BOUNDED: 0,
  UNBOUNDED: 1,
  NOT_DEPLOYED: 2,
  BLIND: 3,
  PARTIAL: 4,
  NO_TOKEN: 5,
  UNATTRIBUTED: 6,
};
const ROUTE = '/api/health/storage/detail';

function done(code, label, lines) {
  console.log(`\n[TRA-3011] ${label} (exit ${code})`);
  for (const l of lines) console.log(`  ${l}`);
  process.exit(code);
}

// ── RTH overlap ─────────────────────────────────────────────────────────────
// The whole point of the guard: `/data` growth is trading-day shaped, so a window
// that never touches a session measures the wrong thing and reads as "flat".
function rthOverlapMinutes(fromMs, toMs) {
  if (!(toMs > fromMs)) return 0;
  let total = 0;
  const dayMs = 86_400_000;
  const start = new Date(fromMs);
  for (
    let d = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
    d <= toMs;
    d += dayMs
  ) {
    const dow = new Date(d).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const open = d + 13.5 * 3_600_000;
    const close = d + 20 * 3_600_000;
    const lo = Math.max(open, fromMs);
    const hi = Math.min(close, toMs);
    if (hi > lo) total += (hi - lo) / 60_000;
  }
  return Math.round(total);
}

// ── Fetch + normalise one reading ───────────────────────────────────────────
async function takeSample() {
  if (!TOKEN) {
    done(EXIT.NO_TOKEN, 'NO_TOKEN — no admin token supplied', [
      `host    ${HOST}`,
      `route   ${ROUTE} (admin-gated, TRA-2599)`,
      'Export TRADING_ADMIN_TOKEN, or POST /api/auth/login and pass --token=<jwt>.',
    ]);
  }

  let res;
  try {
    res = await fetch(`${HOST}${ROUTE}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    done(EXIT.BLIND, `BLIND — ${ROUTE} unreachable`, [String(err?.message ?? err)]);
  }
  if (res.status === 401 || res.status === 403) {
    done(EXIT.NO_TOKEN, `NO_TOKEN — ${ROUTE} returned ${res.status}`, [
      res.status === 401
        ? 'Token missing, malformed or expired (24h TTL).'
        : 'Valid token, non-admin account. This route needs requireAdmin.',
    ]);
  }
  if (!res.ok) done(EXIT.BLIND, `BLIND — ${ROUTE} returned ${res.status}`, []);

  let body;
  try {
    body = await res.json();
  } catch (err) {
    done(EXIT.BLIND, `BLIND — ${ROUTE} body did not parse`, [String(err?.message ?? err)]);
  }

  const disk = body?.disk;
  const usage = body?.usage;
  // Key-in-body deploy detector, both halves of this ticket. Neither absence is a
  // small number; both are "not the build I need".
  if (!usage || !Array.isArray(usage.entries)) {
    done(EXIT.NOT_DEPLOYED, `NOT_DEPLOYED — 200 but no \`usage\` block on ${ROUTE}`, [
      `host  ${HOST}`,
      'The TRA-2420 per-entry walk is not on this build. Deploy, then re-run.',
    ]);
  }
  if (!disk?.watermark) {
    done(EXIT.NOT_DEPLOYED, `NOT_DEPLOYED — 200 but no \`disk.watermark\` on ${ROUTE}`, [
      `host  ${HOST}`,
      'This build predates 00a8cbb (TRA-3011 first half). Deploy, then re-run.',
    ]);
  }
  if (usage.truncated) {
    done(EXIT.BLIND, 'BLIND — the walk hit its file cap; every count is a floor', [
      `totalFiles  ${usage.totalFiles}`,
    ]);
  }
  if (Array.isArray(usage.errors) && usage.errors.length > 0) {
    done(EXIT.BLIND, 'BLIND — part of the tree was unreadable; the walk is short by an unknown amount', [
      ...usage.errors.slice(0, 5).map((e) => `unreadable  ${e.path} — ${e.reason}`),
    ]);
  }
  // The axis that failed. A filesystem that declines to publish an inode table makes
  // this ticket ungradeable — it must NOT read as "plenty free".
  if (typeof disk.inodesTotal !== 'number' || typeof disk.inodesFree !== 'number') {
    done(EXIT.BLIND, 'BLIND — no inode table on this volume, so the axis that failed is unmeasurable', [
      `inodesTotal ${JSON.stringify(disk.inodesTotal)}  inodesFree ${JSON.stringify(disk.inodesFree)}`,
      'A null inode reading is NOT 100% free. That assumption is why nothing alerted.',
    ]);
  }

  const entries = {};
  let other = 0;
  for (const e of usage.entries) {
    const inodes = (e.files ?? 0) + (e.dirs ?? 0);
    if (inodes >= 2) entries[e.name] = { files: e.files ?? 0, dirs: e.dirs ?? 0, bytes: e.bytes ?? 0 };
    else other += inodes;
  }

  // Provenance. `storage/detail` carries no build block, and a sample whose writing
  // build is unknown cannot be compared against one taken across a deploy — the same
  // trap TRA-3035 hit from the other side. An unreachable version route is not fatal
  // (the walk is still a walk), it just records `null` honestly.
  let commit = body?.build?.commitShort ?? null;
  if (!commit) {
    try {
      const v = await fetch(`${HOST}/api/health/version`, { signal: AbortSignal.timeout(20_000) });
      if (v.ok) commit = (await v.json())?.commitShort ?? null;
    } catch {
      commit = null;
    }
  }

  return {
    at: usage.scannedAt ?? new Date(Date.now()).toISOString(),
    host: HOST,
    commit,
    bootedAt: disk.watermark.bootedAt ?? null,
    inodesTotal: disk.inodesTotal,
    inodesFree: disk.inodesFree,
    inodesUsed: disk.inodesTotal - disk.inodesFree,
    walkInodes: usage.entries.reduce((n, e) => n + (e.files ?? 0) + (e.dirs ?? 0), 0),
    freePct: disk.freePct ?? null,
    inodeFreePct: disk.inodeFreePct ?? null,
    watermark: {
      readings: disk.watermark.readings ?? null,
      failedReadings: disk.watermark.failedReadings ?? null,
      inodeFreePctMin: disk.watermark.inodeFreePctMin ?? null,
      freePctMin: disk.watermark.freePctMin ?? null,
      belowThresholdSeen: disk.watermark.belowThresholdSeen ?? null,
      exhaustedSeen: disk.watermark.exhaustedSeen ?? null,
    },
    entries,
    singletonInodes: other,
  };
}

// ── Single-sample structural checks ─────────────────────────────────────────
// These do not need a window, which matters: the bound on `backups/` is a CAP, and a
// cap is violated at a point in time, not over an interval.
function structural(s) {
  const residual = s.inodesUsed - s.walkInodes;
  const residualPct = s.inodesUsed > 0 ? (Math.abs(residual) / s.inodesUsed) * 100 : 0;
  const backupsFiles = s.entries['backups']?.files ?? 0;
  return {
    residual,
    residualPct: Number(residualPct.toFixed(3)),
    backupsFiles,
    backupsOverBudget: backupsFiles > BACKUPS_MAX_FILES,
  };
}

function ranked(sample) {
  return Object.entries(sample.entries)
    .map(([name, e]) => ({ name, inodes: e.files + e.dirs, ...e }))
    .sort((a, b) => b.inodes - a.inodes);
}

function readSeries() {
  if (!existsSync(SERIES)) return [];
  return readFileSync(SERIES, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

// ── Grade ───────────────────────────────────────────────────────────────────
function grade(series) {
  const latest = series[series.length - 1];
  const st = structural(latest);

  const ctx = [
    `host        ${latest.host}`,
    `sample      ${latest.at}  commit ${latest.commit ?? '?'}  boot ${latest.bootedAt ?? '?'}`,
    `inodes      ${latest.inodesUsed} used / ${latest.inodesTotal} (${latest.inodeFreePct}% free)`,
    `bytes       ${latest.freePct}% free  ← healthy through the whole outage; not the axis`,
    `walk        ${latest.walkInodes} inodes attributed, residual ${st.residual} (${st.residualPct}%)`,
    `watermark   readings ${latest.watermark.readings}, failed ${latest.watermark.failedReadings}, ` +
      `inodeFreePctMin ${latest.watermark.inodeFreePctMin} — SINCE BOOT ${latest.bootedAt}`,
  ];

  if (st.residualPct > MAX_RESIDUAL_PCT) {
    done(EXIT.UNATTRIBUTED, `UNATTRIBUTED — ${st.residualPct}% of used inodes are outside the walk`, [
      ...ctx,
      `limit       ${MAX_RESIDUAL_PCT}%`,
      'Something is consuming inodes that this walk does not see. Clearing a named',
      'writer against a short attribution names the wrong one.',
    ]);
  }
  if (st.backupsOverBudget) {
    done(EXIT.UNBOUNDED, `UNBOUNDED — backups/ holds ${st.backupsFiles} files, over the ${BACKUPS_MAX_FILES} budget`, [
      ...ctx,
      "TRA-2817's pruneBackupsToBudget is not holding. This is the writer that took the",
      'inode table to 65,524/65,536 on 07-31.',
    ]);
  }

  const top = ranked(latest)
    .slice(0, 8)
    .map(
      (e) =>
        `  ${e.name.padEnd(22)} ${String(e.inodes).padStart(6)} inodes  (${e.files} files, ${e.dirs} dirs, ${(
          e.bytes / 1048576
        ).toFixed(1)} MB)`,
    );

  if (series.length < 2) {
    done(EXIT.PARTIAL, 'PARTIAL — one sample has no rate; structural checks pass but no trend', [
      ...ctx,
      '',
      'holdings (this sample):',
      ...top,
      '',
      `backups/    ${st.backupsFiles} files <= ${BACKUPS_MAX_FILES} budget — the TRA-2817 cap HOLDS at this instant`,
      'Re-run --sample after an RTH session to get a graded window.',
    ]);
  }

  const first = series[0];
  const fromMs = Date.parse(first.at);
  const toMs = Date.parse(latest.at);
  const spanHours = (toMs - fromMs) / 3_600_000;
  const rth = rthOverlapMinutes(fromMs, toMs);

  const deltas = new Map();
  for (const [name, e] of Object.entries(latest.entries)) {
    const was = first.entries[name];
    deltas.set(name, e.files + e.dirs - (was ? was.files + was.dirs : 0));
  }
  for (const name of Object.keys(first.entries)) if (!deltas.has(name)) {
    deltas.set(name, -(first.entries[name].files + first.entries[name].dirs));
  }
  const deltaLines = [...deltas.entries()]
    .filter(([, d]) => d !== 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, d]) => `  ${name.padEnd(22)} ${d > 0 ? '+' : ''}${d} inodes`);

  const netInodes = latest.inodesUsed - first.inodesUsed;
  const boots = new Set(series.map((s) => s.bootedAt)).size;

  const window = [
    '',
    `window      ${first.at} → ${latest.at}  (${spanHours.toFixed(2)} h, ${series.length} samples, ${boots} boot generation${
      boots === 1 ? '' : 's'
    })`,
    `RTH overlap ${rth} min (need >= ${MIN_RTH_MINUTES})`,
    `net inodes  ${netInodes > 0 ? '+' : ''}${netInodes} used across the window`,
    '',
    'per-entry delta:',
    ...(deltaLines.length ? deltaLines : ['  (every entry flat)']),
    '',
    'holdings (latest):',
    ...top,
  ];
  if (boots > 1) {
    window.push(
      '',
      `NOTE  the box rebooted inside this window (${boots} generations). Watermark minima are`,
      '      since-boot and are NOT compared across it. The walk is absolute and is.',
    );
  }

  if (rth < MIN_RTH_MINUTES) {
    done(EXIT.PARTIAL, `PARTIAL — the window covers ${rth} min of RTH; growth here is trading-day shaped`, [
      ...ctx,
      ...window,
      '',
      'An overnight/weekend window on this volume is flat whether or not the writer is',
      'bounded. A flat reading here is NOT evidence of a bound.',
    ]);
  }

  // A falling or flat inode count over a real session is the bound, demonstrated.
  if (netInodes <= 0) {
    done(EXIT.BOUNDED, `BOUNDED — inode usage did not grow across ${rth} min of RTH`, [
      ...ctx,
      ...window,
      '',
      `backups/    ${st.backupsFiles} files <= ${BACKUPS_MAX_FILES} — TRA-2817's prune is holding the cap`,
    ]);
  }

  const perDay = netInodes / (spanHours / 24);
  const horizonDays = perDay > 0 ? latest.inodesFree / perDay : Infinity;
  const lines = [
    ...ctx,
    ...window,
    '',
    `rate        ${perDay.toFixed(1)} inodes/day net`,
    `horizon     ${horizonDays === Infinity ? 'unbounded' : `${horizonDays.toFixed(0)} days`} to exhaustion ` +
      `at that rate (need >= ${MIN_HORIZON_DAYS})`,
    `backups/    ${st.backupsFiles} files <= ${BACKUPS_MAX_FILES} — TRA-2817's prune cap`,
  ];
  if (horizonDays < MIN_HORIZON_DAYS) {
    done(EXIT.UNBOUNDED, `UNBOUNDED — ${horizonDays.toFixed(0)} days of inode headroom at the measured rate`, [
      ...lines,
      '',
      'The largest positive delta above is the writer to bound. Retention decision needed.',
    ]);
  }
  done(EXIT.BOUNDED, `BOUNDED — ${horizonDays.toFixed(0)} days of inode headroom at the measured rate`, lines);
}

// ── Controls ────────────────────────────────────────────────────────────────
async function selfTest() {
  const { createServer } = await import('node:http');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const execFileAsync = promisify(execFile);

  const dir = mkdtempSync(join(tmpdir(), 'tra3011-'));
  const GOOD_TOKEN = 'tra3011-self-test-admin-token';

  const entry = (name, files, dirs, bytes = 1024) => ({ name, kind: 'dir', files, dirs, bytes });
  const body = (over = {}, entriesOver = null) => ({
    build: { commitShort: 'deadbee' },
    disk: {
      readable: true,
      freePct: 68.4,
      inodesTotal: 65536,
      inodesFree: 42466,
      inodeFreePct: 64.8,
      watermark: {
        bootedAt: '2026-08-06T03:54:30.329Z',
        readings: 17,
        failedReadings: 0,
        freePctMin: 68.37,
        inodeFreePctMin: 64.79,
        belowThresholdSeen: false,
        exhaustedSeen: null,
      },
      ...over,
    },
    usage: {
      root: '/data',
      scannedAt: '2026-08-06T20:30:00.000Z',
      totalFiles: 18608,
      truncated: false,
      errors: [],
      entries: entriesOver ?? [
        entry('users', 10454, 2229),
        entry('backups', 6576, 2000),
        entry('option-chains', 1351, 54),
        entry('orphaned-books', 76, 112),
      ],
    },
  });

  // A prior sample, written into a series file. `used` is the knob the trend turns on.
  const sampleLine = (at, bootedAt, inodesFree, entries) =>
    JSON.stringify({
      at,
      host: 'stub',
      commit: 'deadbee',
      bootedAt,
      inodesTotal: 65536,
      inodesFree,
      inodesUsed: 65536 - inodesFree,
      walkInodes: Object.values(entries).reduce((n, e) => n + e.files + e.dirs, 0),
      freePct: 68.4,
      inodeFreePct: (inodesFree / 65536) * 100,
      watermark: { readings: 5, failedReadings: 0, inodeFreePctMin: 64.9, freePctMin: 68.5 },
      entries,
      singletonInodes: 0,
    });

  const BASE_ENTRIES = {
    users: { files: 10454, dirs: 2229, bytes: 1024 },
    backups: { files: 6576, dirs: 2000, bytes: 1024 },
    'option-chains': { files: 1351, dirs: 54, bytes: 1024 },
    'orphaned-books': { files: 76, dirs: 112, bytes: 1024 },
  };
  // Same walk, one day earlier — used to build prior samples with a chosen delta.
  const shifted = (usersDelta) => ({
    ...BASE_ENTRIES,
    users: { ...BASE_ENTRIES.users, files: BASE_ENTRIES.users.files - usersDelta },
  });

  const seriesFile = (name, lines) => {
    const p = join(dir, name);
    writeFileSync(p, lines.join('\n') + '\n');
    return p;
  };

  // walkInodes for the live stub = 10454+2229+6576+2000+1351+54+76+112 = 22852
  const LIVE_WALK = 22852;
  const LIVE_USED = 65536 - 42466; // 23070 → residual 218 (0.94%), inside the 5% limit

  const CASES = [
    [
      'BOUNDED — a real RTH window whose net growth clears the horizon',
      body(),
      // prior sample 08-06T04:00Z, 26 fewer users files → +26 net over the session
      [
        '--series=' +
          seriesFile('bounded.jsonl', [
            sampleLine('2026-08-06T04:00:00.000Z', '2026-08-06T03:54:30.329Z', 42492, shifted(26)),
          ]),
      ],
      EXIT.BOUNDED,
    ],
    [
      'UNBOUNDED — same window, a writer adding 4k inodes/session',
      body(),
      [
        '--series=' +
          seriesFile('unbounded.jsonl', [
            sampleLine('2026-08-06T04:00:00.000Z', '2026-08-06T03:54:30.329Z', 46466, shifted(4000)),
          ]),
      ],
      EXIT.UNBOUNDED,
    ],
    [
      // THE TRAP. Identical structural health, identical flat walk — but the window is
      // 04:00Z→08:00Z, entirely outside RTH. A grader without this check publishes
      // BOUNDED off a box that has simply not been asked to write anything yet.
      'PARTIAL — a flat OVERNIGHT window must not read as a bound',
      body({}, undefined),
      [
        '--series=' +
          seriesFile('overnight.jsonl', [
            sampleLine('2026-08-06T02:00:00.000Z', '2026-08-06T01:00:00.000Z', 42466, BASE_ENTRIES),
          ]),
        '--now-at=2026-08-06T08:00:00.000Z',
      ],
      EXIT.PARTIAL,
    ],
    [
      'PARTIAL — a single sample has no rate',
      body(),
      ['--series=' + join(dir, 'empty.jsonl')],
      EXIT.PARTIAL,
    ],
    [
      'UNBOUNDED — backups/ over the TRA-2817 cap, caught on ONE sample (no window needed)',
      body({}, [entry('users', 10454, 2229), entry('backups', 9000, 2000)]),
      ['--series=' + join(dir, 'empty2.jsonl'), '--max-residual-pct=100'],
      EXIT.UNBOUNDED,
    ],
    [
      'UNATTRIBUTED — the walk sees a fraction of the used inodes',
      body({}, [entry('users', 100, 10)]),
      ['--series=' + join(dir, 'empty3.jsonl')],
      EXIT.UNATTRIBUTED,
    ],
    [
      'BLIND — no inode table (must NOT read as plenty free)',
      body({ inodesTotal: null, inodesFree: null, inodeFreePct: null }),
      ['--series=' + join(dir, 'empty4.jsonl')],
      EXIT.BLIND,
    ],
    [
      'BLIND — truncated walk, every count is a floor',
      (() => {
        const b = body();
        b.usage.truncated = true;
        return b;
      })(),
      ['--series=' + join(dir, 'empty5.jsonl')],
      EXIT.BLIND,
    ],
    [
      'NOT_DEPLOYED — 200 with no disk.watermark (build predates 00a8cbb)',
      (() => {
        const b = body();
        delete b.disk.watermark;
        return b;
      })(),
      ['--series=' + join(dir, 'empty6.jsonl')],
      EXIT.NOT_DEPLOYED,
    ],
    [
      'NOT_DEPLOYED — 200 with no usage block (build predates TRA-2420)',
      { disk: { inodesTotal: 65536, inodesFree: 42466, watermark: {} } },
      ['--series=' + join(dir, 'empty7.jsonl')],
      EXIT.NOT_DEPLOYED,
    ],
  ];

  let payload = null;
  let sawAuthorized = false;
  const server = createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0];
    if (url !== ROUTE) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    if (req.headers['authorization'] !== `Bearer ${GOOD_TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    sawAuthorized = true;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const host = `http://127.0.0.1:${server.address().port}`;

  let failures = 0;
  const seen = [];
  const scrubbed = { ...process.env };
  delete scrubbed['TRADING_ADMIN_TOKEN'];
  delete scrubbed['TRADINGAI_ADMIN_TOKEN'];
  delete scrubbed['ADMIN_TOKEN'];

  const run = async (extra, env = scrubbed) => {
    try {
      const r = await execFileAsync(
        process.execPath,
        [process.argv[1], `--host=${host}`, `--token=${GOOD_TOKEN}`, '--grade-only', ...extra],
        { env },
      );
      return { code: 0, out: r.stdout };
    } catch (err) {
      return { code: err.code ?? -1, out: err.stdout ?? '' };
    }
  };

  for (const [label, b, extra, want] of CASES) {
    payload = b;
    const { code, out } = await run(extra);
    seen.push(code);
    const ok = code === want;
    if (!ok) failures += 1;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  exit ${code} (want ${want})  ${label}`);
    if (!ok) console.log(out);
  }

  // NO_TOKEN, both directions.
  payload = body();
  for (const [label, extra, tok] of [
    ['no token at all → NO_TOKEN (not BLIND)', ['--series=' + join(dir, 'e8.jsonl')], null],
    ['token rejected 401 → NO_TOKEN (not BLIND)', ['--series=' + join(dir, 'e9.jsonl')], 'wrong'],
  ]) {
    let code = 0;
    let out = '';
    try {
      const args = [process.argv[1], `--host=${host}`, '--grade-only', ...extra];
      if (tok) args.push(`--token=${tok}`);
      const r = await execFileAsync(process.execPath, args, { env: scrubbed });
      out = r.stdout;
    } catch (err) {
      code = err.code ?? -1;
      out = err.stdout ?? '';
    }
    seen.push(code);
    const ok = code === EXIT.NO_TOKEN;
    if (!ok) failures += 1;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  exit ${code} (want ${EXIT.NO_TOKEN})  ${label}`);
    if (!ok) console.log(out);
  }

  // Positive mark on the ATTRIBUTION, not just the exit code: the BOUNDED run must
  // name `users` as the growing entry. A grader that reaches 0 while ranking the
  // wrong writer is worse than one that fails.
  payload = body();
  const boundedRun = await run([
    '--series=' +
      seriesFile('bounded2.jsonl', [
        sampleLine('2026-08-06T04:00:00.000Z', '2026-08-06T03:54:30.329Z', 42492, shifted(26)),
      ]),
  ]);
  if (!/per-entry delta:[\s\S]*users\s+\+26 inodes/.test(boundedRun.out)) {
    failures += 1;
    console.log('  FAIL  BOUNDED run did not attribute the growth to `users`');
    console.log(boundedRun.out);
  } else {
    console.log('  ok    growth attributed to the named entry (`users +26 inodes`)');
  }

  // The watermark must never be trended across a boot change. Two samples, different
  // `bootedAt`, must still grade (the walk is absolute) AND say so.
  payload = body();
  const rebooted = await run([
    '--series=' +
      seriesFile('reboot.jsonl', [
        sampleLine('2026-08-06T04:00:00.000Z', '2026-08-06T01:00:00.000Z', 42492, shifted(26)),
      ]),
  ]);
  if (!/rebooted inside this window/.test(rebooted.out)) {
    failures += 1;
    console.log('  FAIL  a boot change inside the window was not flagged');
  } else {
    console.log('  ok    boot change inside the window is flagged, walk still graded');
  }

  if (!sawAuthorized) {
    failures += 1;
    console.log('  FAIL  no control ever reached the gated route with a valid token');
  } else {
    console.log('  ok    gated route reached WITH a Bearer token (stub 401s without one)');
  }

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
  console.log(`\n[TRA-3011 self-test] ${failures === 0 ? 'PASS' : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

// ── Entry ───────────────────────────────────────────────────────────────────
if (flag('self-test')) {
  selfTest().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  const main = async () => {
    const series = readSeries();
    const sample = await takeSample();
    // `--now-at` exists ONLY for the controls: it stamps the fresh reading so a window
    // of a chosen shape can be built without waiting for the clock.
    const nowAt = arg('now-at');
    if (nowAt) sample.at = nowAt;
    if (!flag('grade-only')) {
      // `getDataDirUsage` memoises for USAGE_CACHE_MS (60 s), so two calls inside that
      // window return the SAME walk with the same `scannedAt`. Appending it twice would
      // manufacture a second "sample" carrying no new information — and two identical
      // rows are exactly what a flat trend looks like. Keying the series on `scannedAt`
      // rather than wall-clock makes the duplicate detectable; this drops it.
      if (series.some((s) => s.at === sample.at)) {
        console.log(`[TRA-3011] NOT appended — cached walk, scannedAt ${sample.at} is already in the series`);
      } else {
        appendFileSync(SERIES, JSON.stringify(sample) + '\n');
        console.log(`[TRA-3011] appended sample ${sample.at} → ${SERIES}`);
      }
    }
    grade([...series, sample]);
  };
  main().catch((err) => {
    done(EXIT.BLIND, 'BLIND — unexpected failure', [String(err?.stack ?? err)]);
  });
}
