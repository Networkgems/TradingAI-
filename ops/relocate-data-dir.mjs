#!/usr/bin/env node
// TRA-4896 — move the self-host's book OFF the ephemeral scratch tree, once, safely.
//
// `ecosystem.config.cjs` now defaults DATA_DIR to a machine-wide service-state path
// (`%ProgramData%\TradingAI\data` / `/srv/tradingai/data`) instead of a path inside the
// checkout. That change moves the POINTER. This script moves the BYTES, and it exists
// because the failure mode of forgetting is silent in the worst possible way:
//
//   A launch against a fresh, empty DATA_DIR does not error. The stores all create
//   themselves, the boot hydrate reads back what it just wrote, `/api/health/durability`
//   goes GREEN — and every multi-session ledger on the box (eod-archive-participation,
//   live-nav-tripwire, giveback-arm-floor, parity-reconcile, cost-aware-gate) restarts
//   from zero rows. A zero-row window does not read as "data missing". It reads as a
//   QUIET WINDOW, which is a number someone will publish. That is TRA-522's swap in the
//   other direction, with a worse detector story.
//
// So: copy, never move. The source is left byte-intact as the rollback, and the verify
// pass is a real re-stat of every file at the target, not a trust of the copy's return.
//
// ── The live-writer refusal ──────────────────────────────────────────────────────────
// The book's hot state is SQLite in WAL mode (`state.db` + `-wal` + `-shm`). Copying
// that triplet out from under a running writer yields a torn snapshot whose corruption
// surfaces LATER, at hydrate, on a box that has already discarded the source. There is
// no version of this that is safe while the server is up, so a reachable health port is
// a hard REFUSAL, not a warning. Order is: stop the server → run this → start it.
//
// Usage:
//   node ops/relocate-data-dir.mjs --dry-run       # always safe, prints the plan
//   node ops/relocate-data-dir.mjs                 # requires the server stopped
//   node ops/relocate-data-dir.mjs --from=<dir> --to=<dir> --port=4242
//
// Exit codes (a non-zero is never "probably fine"):
//   0  DONE          — copied and verified, or already current (idempotent re-run)
//   1  REFUSED_LIVE  — something is still serving the health port
//   2  REFUSED_TARGET— target exists with content this script did not put there
//   3  BLIND         — could not read the source, or verification could not be completed
//   4  USAGE

import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, utimesSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXIT = { DONE: 0, REFUSED_LIVE: 1, REFUSED_TARGET: 2, BLIND: 3, USAGE: 4 };

// A marker written into the target so a re-run can tell "I made this" from "something
// else lives here". Without it, resuming an interrupted copy is indistinguishable from
// overwriting an unrelated directory, and this script would have to refuse both.
const MARKER = '.tra-4896-relocated';

function die(code, msg) {
  console.error(msg);
  process.exit(code);
}

// ── args ─────────────────────────────────────────────────────────────────────────────
// Values attach with `=`. TRA-4420's lesson from render-redeploy.mjs: an unrecognised
// flag that is silently ignored turns a typo into a real run of the default action.
const args = process.argv.slice(2);
const opts = { dryRun: false, from: null, to: null, port: 4242 };
for (const a of args) {
  if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--help' || a === '-h') {
    console.log(
      'usage: node ops/relocate-data-dir.mjs [--dry-run] [--from=<dir>] [--to=<dir>] [--port=<n>]',
    );
    process.exit(EXIT.DONE);
  } else if (a.startsWith('--from=')) opts.from = a.slice(7);
  else if (a.startsWith('--to=')) opts.to = a.slice(5);
  else if (a.startsWith('--port=')) opts.port = Number(a.slice(7));
  else die(EXIT.USAGE, `unrecognised argument: ${a}\n(values attach with '=', e.g. --to=C:/ProgramData/TradingAI/data)`);
}
if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
  die(EXIT.USAGE, `--port must be a valid port, got: ${opts.port}`);
}

// ── source + target ──────────────────────────────────────────────────────────────────
// The source default is the pre-TRA-4896 location: the in-bundle path the old
// ecosystem default pinned. Spelled literally, not re-derived from the ecosystem file,
// because the ecosystem file is exactly what this migration changes.
const source = resolve(opts.from ?? join(REPO_ROOT, 'packages', 'server', 'data'));
const target = resolve(opts.to ?? defaultTarget());

function defaultTarget() {
  if (process.platform === 'win32') {
    return join(process.env.ProgramData || 'C:\\ProgramData', 'TradingAI', 'data');
  }
  return '/srv/tradingai/data';
}

if (source === target) {
  console.log(`ALREADY CURRENT — source and target are the same path:\n  ${source}`);
  process.exit(EXIT.DONE);
}
if (!existsSync(source)) {
  die(EXIT.BLIND, `BLIND — source does not exist: ${source}\nNothing to migrate, and an absent source is not the same as an empty one.`);
}

// ── walk the source ──────────────────────────────────────────────────────────────────
function walk(root, rel = '') {
  const out = [];
  let entries;
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true });
  } catch (e) {
    die(EXIT.BLIND, `BLIND — cannot read ${join(root, rel)}: ${e.message}`);
  }
  for (const e of entries) {
    const r = rel ? join(rel, e.name) : e.name;
    if (e.isDirectory()) out.push(...walk(root, r));
    else if (e.isFile()) out.push(r);
    // symlinks/sockets/devices are deliberately skipped and REPORTED, never followed —
    // following one would copy bytes from outside the book.
    else console.warn(`  skip (not a regular file): ${r}`);
  }
  return out;
}

const files = walk(source);
const totalBytes = files.reduce((n, f) => n + statSync(join(source, f)).size, 0);

console.log(`TRA-4896 data dir relocation`);
console.log(`  from : ${source}`);
console.log(`  to   : ${target}`);
console.log(`  files: ${files.length}  bytes: ${totalBytes.toLocaleString()}`);

// The SQLite triplet is called out by name so the live-writer refusal below has a
// visible subject rather than being an abstract caution.
const sqlite = files.filter((f) => /(^|[\\/])state\.db(-wal|-shm)?$/.test(f));
if (sqlite.length > 0) console.log(`  hot-state (WAL, must be quiesced): ${sqlite.join(', ')}`);

// ── refuse while a writer is live ────────────────────────────────────────────────────
async function probeOnce(port) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 2500);
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctl.signal });
    return true; // any HTTP answer at all means a process owns the port
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/**
 * A SINGLE instant is not enough to call this port free, and that is measured, not
 * theoretical: while building this script a dry run read "not responding" on a box
 * whose trading-server was up — pm2 `autorestart` was cycling the process (pid
 * 21872 -> 17288, uptime 41s), and the probe landed in the gap between two live
 * writers. A one-shot probe therefore clears a WAL writer that is back two seconds
 * later, which is precisely the torn-snapshot case this refusal exists to prevent.
 *
 * So: sample across a window and treat ANY response as LIVE. The asymmetry is
 * deliberate — a false "live" costs one retry after a real `pm2 stop`, a false
 * "free" costs a silently corrupt book.
 */
async function healthPortIsLive(port, samples = 4, gapMs = 1500) {
  for (let i = 0; i < samples; i += 1) {
    if (await probeOnce(port)) return true;
    if (i < samples - 1) await new Promise((r) => setTimeout(r, gapMs));
  }
  return false;
}

const live = await healthPortIsLive(opts.port);
console.log(
  `  server on :${opts.port}: ${live ? 'LIVE' : 'no response across 4 probes / ~4.5s'}`,
);

if (opts.dryRun) {
  console.log(
    `\nDRY RUN — nothing written.${live ? `\nNOTE: the server is LIVE; a real run would REFUSE (exit ${EXIT.REFUSED_LIVE}).` : ''}`,
  );
  process.exit(EXIT.DONE);
}

if (live) {
  die(
    EXIT.REFUSED_LIVE,
    `REFUSED — something is serving :${opts.port}.\n`
      + `${sqlite.length > 0 ? `Copying ${sqlite.join(' + ')} out from under a live WAL writer yields a torn snapshot\n`
        + 'whose corruption surfaces later, at hydrate. ' : ''}`
      + 'Stop trading-server first (elevated: `pm2 stop trading-server`), re-run this, then start it.',
  );
}

// ── target occupancy ─────────────────────────────────────────────────────────────────
if (existsSync(target)) {
  const existing = walk(target);
  const mine = existsSync(join(target, MARKER));
  if (existing.length > 0 && !mine) {
    die(
      EXIT.REFUSED_TARGET,
      `REFUSED — ${target} already holds ${existing.length} file(s) and carries no ${MARKER} marker.\n`
        + 'This script did not create that content, so it will not overwrite it. Inspect it, then\n'
        + 'either move it aside or re-run with --to=<a different dir>.',
    );
  }
  if (mine) console.log(`  target carries ${MARKER} — resuming/refreshing a previous run`);
}

// ── copy ─────────────────────────────────────────────────────────────────────────────
mkdirSync(target, { recursive: true });
let copied = 0;
for (const f of files) {
  const src = join(source, f);
  const dst = join(target, f);
  mkdirSync(dirname(dst), { recursive: true });
  try {
    copyFileSync(src, dst);
    // Preserve mtime: several stores and more than one grader date-bucket off file
    // mtime, and a migration that restamps every file to "now" would silently
    // re-date the entire history into a single day.
    const st = statSync(src);
    utimesSync(dst, st.atime, st.mtime);
    copied += 1;
  } catch (e) {
    die(EXIT.BLIND, `BLIND — copy failed at ${f}: ${e.message}\nTarget is INCOMPLETE; source is untouched. Do not start the server against ${target}.`);
  }
}

// ── verify by re-stat, not by trusting the copy ──────────────────────────────────────
const mismatches = [];
for (const f of files) {
  const s = statSync(join(source, f));
  let d;
  try {
    d = statSync(join(target, f));
  } catch {
    mismatches.push(`${f}: MISSING at target`);
    continue;
  }
  if (s.size !== d.size) mismatches.push(`${f}: size ${s.size} -> ${d.size}`);
}
if (mismatches.length > 0) {
  die(
    EXIT.BLIND,
    `BLIND — ${mismatches.length} file(s) did not verify:\n  ${mismatches.slice(0, 20).join('\n  ')}\n`
      + `Source at ${source} is untouched. Do not start the server against the target.`,
  );
}

try {
  const fs = await import('node:fs');
  fs.writeFileSync(
    join(target, MARKER),
    `${new Date().toISOString()} TRA-4896 relocated from ${source} (${files.length} files, ${totalBytes} bytes)\n`,
  );
} catch (e) {
  console.warn(`  (marker not written: ${e.message})`);
}

console.log(
  `\nDONE — ${copied} file(s), ${totalBytes.toLocaleString()} bytes copied and VERIFIED at ${target}.\n`
    + `Source left intact at ${source} as the rollback.\n`
    + 'Next: start trading-server so it picks up the new DATA_DIR (elevated, and it must be a\n'
    + 'delete+start or a reboot->resurrect -- a plain `pm2 restart` re-execs with the SAVED env\n'
    + 'and will NOT pick up a changed ecosystem default), then confirm:\n'
    + `  curl -s http://127.0.0.1:${opts.port}/api/health/durability\n`
    + '  -> expect violations: [] and ephemeralReason: null',
);
process.exit(EXIT.DONE);
