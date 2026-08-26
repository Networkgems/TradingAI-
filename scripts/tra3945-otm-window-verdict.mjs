#!/usr/bin/env node
// TRA-3945 — the OFFLINE hand-run that writes a verdict onto the persisted OTM
// evaluation-window record. The process never pronounces; a human's ruling is
// carried onto the record by exactly two writers, and this is the fallback one:
//
//   PRIMARY (no restart, atN read off the fold in the same beat):
//     POST /api/health/otm-evaluation-window/verdict?apply=true&confirm=TRA-3945
//       body {status, by, note}   (admin; dry-run without apply)
//
//   THIS SCRIPT (needs a shell on the data dir + a restart for the wire):
//     node scripts/tra3945-otm-window-verdict.mjs --file=<data-dir>/otm-evaluation-window.json \
//          --status=verdict_fail --by=QuantTrader --note="TRA-39xx: avgR -0.04 seR 0.08 at n=30"
//     node scripts/tra3945-otm-window-verdict.mjs --file=... --status=verdict_insufficient_population \
//          --n=<counted n read off the wire in the same beat> --by=QuantTrader --note="TRA-39xx: ..."
//
// `verdict_insufficient_population` (QuantTrader fd917f86) is accepted ONLY while
// n < targetCloses (30, or 45 once the extension fired) — a full sample is graded
// pass/fail, never retired as starved. This script cannot fold the journal, so
// `--n` is the operator's attestation of the wire's `n`; the route needs no such thing.
//
// Exit 0 written · 2 usage · 3 refused (no ticket ref / window never opened / already has a verdict / starved on a full sample).
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

const STATUSES = ['verdict_pass', 'verdict_fail', 'verdict_insufficient_population'];
const TARGET = 30;
const EXTENSION = 15;

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true'];
  }),
);
const { file, status, by, note } = args;
if (!file || !status || !by || !note) {
  console.error(`usage: --file=<path> --status=${STATUSES.join('|')} --by=<grader> --note="TRA-nnnn ..." [--n=<counted n, required for verdict_insufficient_population>]`);
  process.exit(2);
}
if (!STATUSES.includes(status)) {
  console.error(`refused: status must be ${STATUSES.join('|')}, got ${status}`);
  process.exit(2);
}
if (!/TRA-\d+/.test(note)) {
  console.error('refused: the note must carry the grader\'s ticket reference (TRA-nnnn)');
  process.exit(3);
}
const state = JSON.parse(readFileSync(file, 'utf8'));
if (state.version !== 1 || state.windowId !== 'otm-joint-arm-w1') {
  console.error('refused: not a TRA-3945 window state file');
  process.exit(3);
}
if (state.startedAt === null) {
  console.error('refused: the window never opened (startedAt null) — there is nothing to grade');
  process.exit(3);
}
if (state.verdict) {
  console.error(`refused: a verdict is already written (${state.verdict.status} by ${state.verdict.by} at ${new Date(state.verdict.at).toISOString()})`);
  process.exit(3);
}
let atN = null;
if (status === 'verdict_insufficient_population') {
  atN = Number(args.n);
  if (!Number.isInteger(atN) || atN < 0) {
    console.error('refused: verdict_insufficient_population needs --n=<counted n read off the wire in the same beat>');
    process.exit(2);
  }
  const target = TARGET + (state.extension?.used ? (state.extension.closes ?? EXTENSION) : 0);
  if (atN >= target) {
    console.error(`refused: verdict_insufficient_population at n=${atN} >= target ${target}: a full sample is graded pass/fail, never retired as starved`);
    process.exit(3);
  }
}
state.verdict = { status, note, by, atN, at: Date.now() };
const tmp = `${file}.tmp`;
writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
renameSync(tmp, file);
console.log(JSON.stringify({ ok: true, file, verdict: state.verdict }, null, 2));
console.log('NOTE: the running process caches the state; restart it (or wait for the next deploy) for the wire to reflect the verdict. Prefer the route.');
