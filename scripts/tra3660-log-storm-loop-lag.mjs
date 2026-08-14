#!/usr/bin/env node
// TRA-3660 AC2 — measure event-loop lag as a function of N per-symbol log lines.
//
// The hypothesis on the table (from the CTO's filing) is:
//
//   "~1800+ synchronous `console.log` writes over ~2-4s, from an uninstrumented
//    emitter, is enough to hold the loop 4060ms."
//
// That is a hypothesis supported by coincidence and a clean 3-window negative
// control. It is NOT proven. This harness measures it.
//
// ── Why a write can block at all ────────────────────────────────────────────────
// Node's own docs on `process.stdout` / `process.stderr`: writes are
// **synchronous** when the destination is a FILE (all platforms), a TTY on POSIX,
// or a **PIPE on Linux and Windows**. Render captures container output through a
// pipe on Linux, so on bqb1 every `console.warn` is a blocking `write(2)`.
//
// A pipe has a fixed kernel buffer (64 KiB on Linux by default). While the reader
// keeps up, each write returns immediately and costs microseconds. When the reader
// stalls, the buffer fills and the next write **blocks the whole process** — no
// timers, no I/O callbacks, no HTTP accept. That is event-loop starvation with no
// JS stack to blame it on, which is exactly the `slowSyncPhase: null` shape.
//
// So the honest experiment has to sweep BOTH worlds, because they give completely
// different answers and only one of them is the incident:
//
//   drain   — parent consumes the child's output immediately (healthy collector)
//   stall   — parent leaves the pipe unread for `--stall-ms` (stalled collector)
//
// ── Arms (the controls are the point) ──────────────────────────────────────────
//   write    SUBJECT.  N lines, byte-identical in shape to the real emitter.
//   format   NEGATIVE CONTROL. Builds the same N strings, writes none of them.
//            Isolates the cost of the WRITE from the cost of the formatting.
//            If `write` blocks and `format` does not, the write is the mechanism.
//   batched  THE PROPOSED FIX. One line for the whole batch (what every other
//            branch of this emitter already does). Must not block.
//
// N = 0 is the null control on every arm: it must measure ~0 lag, otherwise the
// instrument itself is what we are reading.
//
// ── Usage ──────────────────────────────────────────────────────────────────────
//   node scripts/tra3660-log-storm-loop-lag.mjs
//   node scripts/tra3660-log-storm-loop-lag.mjs --stall-ms=4000 --json=out.json
//   node scripts/tra3660-log-storm-loop-lag.mjs --n=1824,3648 --repeats=3
//
// Exit codes:
//   0  ran cleanly (read the table — a clean run is NOT a verdict of "reproduced")
//   2  a child failed to produce a measurement (BLIND — never report a number)
//   3  the null control (N=0) itself measured >= NULL_CONTROL_MAX_MS  (instrument
//      is unsound; the numbers below it mean nothing)

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SELF = fileURLToPath(import.meta.url);

/**
 * The real line, byte-for-byte in shape. Length matters and nothing else does:
 * a pipe blocks on BYTES, not on how interesting they are.
 * Live sample (bqb1, 2026-08-13T14:18:46Z):
 *   [yahoo-feed] fetchQuotes: 1/1 symbols failed (Yahoo breaker open, pre-fanout short-circuit) — dropped NVDA
 */
function stormLine(i) {
  const sym = `SYM${String(i % 1000).padStart(4, '0')}`;
  return `[yahoo-feed] fetchQuotes: 1/1 symbols failed (Yahoo breaker open, pre-fanout short-circuit) — dropped ${sym}`;
}

/** The batched form: one line for the whole set, head-named like formatDroppedSymbols. */
function batchedLine(n) {
  const head = Array.from({ length: Math.min(n, 20) }, (_, i) => `SYM${String(i % 1000).padStart(4, '0')}`);
  const more = n > head.length ? ` (+${n - head.length} more)` : '';
  return `[yahoo-feed] fetchQuotes: ${n}/${n} symbols failed (Yahoo breaker open, pre-fanout short-circuit) — dropped ${head.join(',')}${more}`;
}

/** Above this on the N=0 null control the instrument is not trustworthy. */
const NULL_CONTROL_MAX_MS = 150;

/** The production watchdog's acute block threshold (event-loop-watchdog.ts DEFAULT_WATCHDOG.lagMaxMs). */
const WATCHDOG_LAG_MAX_MS = 4000;

// ─────────────────────────────────────────────────────────────────────────────
// CHILD
// ─────────────────────────────────────────────────────────────────────────────

async function runChild() {
  const arg = (k, d) => {
    const hit = process.argv.find(a => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : d;
  };
  const n = Number(arg('n', '0'));
  const arm = arg('arm', 'write');
  const outPath = arg('out', '');

  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();

  // Warm-up: let the loop settle and the histogram collect a clean baseline, then
  // reset so module load / JIT never lands in the measured window.
  await new Promise(r => setTimeout(r, 250));
  h.reset();

  let sink = 0;
  const startedAt = process.hrtime.bigint();

  // The burst runs inside a timer callback — same shape as the real emitter, which
  // runs inside doTick's timer chain — and is PURELY synchronous, so anything it
  // costs is loop-block time by construction.
  await new Promise(resolve => {
    setTimeout(() => {
      if (arm === 'write') {
        for (let i = 0; i < n; i++) console.warn(stormLine(i));
      } else if (arm === 'format') {
        for (let i = 0; i < n; i++) sink += stormLine(i).length;
      } else if (arm === 'batched') {
        if (n > 0) console.warn(batchedLine(n));
      } else {
        throw new Error(`unknown arm ${arm}`);
      }
      resolve();
    }, 20);
  });

  const burstMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  // Yield so the delay histogram's own timer gets a turn and RECORDS the delay it
  // just suffered. Without this the block is real but unmeasured — the same reason
  // the production watchdog can only ever evaluate AFTER a block, never during it.
  await new Promise(r => setTimeout(r, 400));

  const result = {
    n,
    arm,
    lagMaxMs: Number((h.max / 1e6).toFixed(1)),
    lagMeanMs: Number((h.mean / 1e6).toFixed(1)),
    burstWallMs: Number(burstMs.toFixed(1)),
    bytes: arm === 'write' ? n * (stormLine(0).length + 1) : arm === 'batched' && n > 0 ? batchedLine(n).length + 1 : 0,
    sink,
  };
  h.disable();
  writeFileSync(outPath, JSON.stringify(result), 'utf8');
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// PARENT
// ─────────────────────────────────────────────────────────────────────────────

function runOne({ n, arm, stallMs, dir, idx }) {
  return new Promise((resolve, reject) => {
    const outPath = join(dir, `r${idx}.json`);
    const child = spawn(
      process.execPath,
      [SELF, '--child', `--n=${n}`, `--arm=${arm}`, `--out=${outPath}`],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    // stdio streams start PAUSED with no listener attached, so the kernel pipe
    // buffer fills and the child's next write blocks — that is the stalled
    // collector. Attaching the drain handler after `stallMs` releases it.
    const drain = () => {
      child.stdout.resume();
      child.stderr.resume();
    };
    if (stallMs > 0) setTimeout(drain, stallMs).unref?.();
    else drain();

    // Hard stop so a wedged child can never hang the harness.
    const kill = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 60_000);

    child.on('error', reject);
    child.on('exit', code => {
      clearTimeout(kill);
      // Always drain on the way out so a killed child's pipe is not left held.
      drain();
      try {
        const parsed = JSON.parse(readFileSync(outPath, 'utf8'));
        resolve({ ...parsed, stallMs, exitCode: code });
      } catch {
        resolve({ n, arm, stallMs, exitCode: code, lagMaxMs: null, lagMeanMs: null, blind: true });
      }
    });
  });
}

async function runParent() {
  const arg = (k, d) => {
    const hit = process.argv.find(a => a.startsWith(`--${k}=`));
    return hit ? hit.slice(k.length + 3) : d;
  };
  const ns = arg('n', '0,100,500,1000,1824,3648,8000').split(',').map(Number);
  const stalls = arg('stall-ms', '0,4000').split(',').map(Number);
  const repeats = Number(arg('repeats', '1'));
  const jsonOut = arg('json', '');

  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), 'tra3660-'));
  const rows = [];
  let idx = 0;

  console.log('TRA-3660 AC2 — event-loop lag vs N per-symbol log lines');
  console.log(`node ${process.version} · platform ${process.platform} · line ${stormLine(0).length} bytes`);
  console.log(`watchdog acute block threshold = ${WATCHDOG_LAG_MAX_MS}ms (event-loop-watchdog.ts DEFAULT_WATCHDOG.lagMaxMs)`);
  console.log('');

  for (const stallMs of stalls) {
    for (const arm of ['write', 'format', 'batched']) {
      for (const n of ns) {
        for (let r = 0; r < repeats; r++) {
          rows.push(await runOne({ n, arm, stallMs, dir, idx: idx++ }));
        }
      }
    }
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* scratch */ }

  // ── report ────────────────────────────────────────────────────────────────
  for (const stallMs of stalls) {
    const label = stallMs === 0
      ? 'COLLECTOR DRAINING (healthy reader — writes return immediately)'
      : `COLLECTOR STALLED ${stallMs}ms (reader paused; kernel pipe buffer fills)`;
    console.log(`── ${label} ─────────────────────────────`);
    console.log('  arm      |     N |   bytes |  lagMax ms |  burst ms | >= 4000ms?');
    console.log('  ---------+-------+---------+------------+-----------+-----------');
    for (const arm of ['write', 'format', 'batched']) {
      for (const n of ns) {
        const hits = rows.filter(x => x.arm === arm && x.n === n && x.stallMs === stallMs);
        if (hits.length === 0) continue;
        const worst = hits.reduce((a, b) => ((b.lagMaxMs ?? -1) > (a.lagMaxMs ?? -1) ? b : a));
        const trip = worst.lagMaxMs != null && worst.lagMaxMs >= WATCHDOG_LAG_MAX_MS;
        console.log(
          `  ${arm.padEnd(8)} | ${String(n).padStart(5)} | ${String(worst.bytes ?? 0).padStart(7)} | ` +
          `${String(worst.blind ? 'BLIND' : worst.lagMaxMs).padStart(10)} | ${String(worst.burstWallMs ?? '-').padStart(9)} | ` +
          `${trip ? 'TRIP' : ''}`,
        );
      }
    }
    console.log('');
  }

  const blind = rows.filter(r => r.blind);
  if (blind.length > 0) {
    console.error(`BLIND: ${blind.length} cell(s) produced no measurement — do not read the table above as complete.`);
    if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ rows, blind: blind.length }, null, 2), 'utf8');
    process.exit(2);
  }

  // Null control: N=0 must measure ~nothing on every arm and both worlds, or the
  // instrument is measuring itself and every number above it is uninterpretable.
  const nulls = rows.filter(r => r.n === 0);
  const badNull = nulls.find(r => r.lagMaxMs >= NULL_CONTROL_MAX_MS);
  if (badNull) {
    console.error(
      `NULL CONTROL FAILED: N=0 arm=${badNull.arm} stall=${badNull.stallMs}ms measured ` +
      `lagMax ${badNull.lagMaxMs}ms >= ${NULL_CONTROL_MAX_MS}ms. The instrument is not sound on this box; ` +
      `the numbers above are NOT evidence.`,
    );
    if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ rows }, null, 2), 'utf8');
    process.exit(3);
  }
  console.log(`null control (N=0, all arms/worlds): max lagMax ${Math.max(...nulls.map(r => r.lagMaxMs))}ms < ${NULL_CONTROL_MAX_MS}ms — PASS`);

  // ── verdict ───────────────────────────────────────────────────────────────
  const at = (arm, n, stallMs) => rows.filter(r => r.arm === arm && r.n === n && r.stallMs === stallMs)
    .reduce((a, b) => ((b.lagMaxMs ?? -1) > (a.lagMaxMs ?? -1) ? b : a), { lagMaxMs: null });

  console.log('');
  console.log('── VERDICT ──────────────────────────────────────────────────────');
  for (const stallMs of stalls) {
    const tripped = rows.filter(r => r.arm === 'write' && r.stallMs === stallMs && r.lagMaxMs >= WATCHDOG_LAG_MAX_MS);
    const smallestTrip = tripped.length ? Math.min(...tripped.map(r => r.n)) : null;
    const world = stallMs === 0 ? 'draining collector' : `collector stalled ${stallMs}ms`;
    if (smallestTrip != null) {
      console.log(`  ${world}: REPRODUCES — write arm crosses ${WATCHDOG_LAG_MAX_MS}ms at N=${smallestTrip}.`);
    } else {
      const w = at('write', Math.max(...ns), stallMs);
      console.log(`  ${world}: does NOT reproduce — write arm peaks at ${w.lagMaxMs}ms at N=${Math.max(...ns)} (threshold ${WATCHDOG_LAG_MAX_MS}ms).`);
    }
    const f = at('format', Math.max(...ns), stallMs);
    const b = at('batched', Math.max(...ns), stallMs);
    console.log(`    negative control (format-only, no write, N=${Math.max(...ns)}): ${f.lagMaxMs}ms`);
    console.log(`    proposed fix     (batched, one line, N=${Math.max(...ns)}): ${b.lagMaxMs}ms`);
  }
  console.log('');
  console.log('Read the two worlds separately. A reproduction ONLY in the stalled-collector world');
  console.log('still reproduces the incident — bqb1 writes to a pipe on Linux, where the write is');
  console.log('synchronous and a stalled reader blocks the process. It also means the storm is a');
  console.log('NECESSARY condition, not a sufficient one: no storm, no exposure to the stall.');

  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify({
      node: process.version, platform: process.platform,
      lineBytes: stormLine(0).length, watchdogLagMaxMs: WATCHDOG_LAG_MAX_MS, rows,
    }, null, 2), 'utf8');
    console.log(`\nwrote ${jsonOut}`);
  }
}

if (process.argv.includes('--child')) await runChild();
else await runParent();
