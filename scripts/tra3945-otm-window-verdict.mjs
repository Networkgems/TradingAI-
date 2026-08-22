#!/usr/bin/env node
// TRA-3945 — the HAND-RUN that writes `verdict_pass` / `verdict_fail` onto the
// persisted OTM evaluation-window record. The process never pronounces; this
// script is the only writer, and it refuses a note without a ticket reference.
//
//   node scripts/tra3945-otm-window-verdict.mjs --file=<data-dir>/otm-evaluation-window.json \
//        --status=verdict_fail --by=QuantTrader --note="TRA-39xx: avgR -0.04 seR 0.08 at n=30"
//
// Exit 0 written · 2 usage · 3 refused (no ticket ref / window never opened / already has a verdict).
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true'];
  }),
);
const { file, status, by, note } = args;
if (!file || !status || !by || !note) {
  console.error('usage: --file=<path> --status=verdict_pass|verdict_fail --by=<grader> --note="TRA-nnnn ..."');
  process.exit(2);
}
if (status !== 'verdict_pass' && status !== 'verdict_fail') {
  console.error(`refused: status must be verdict_pass|verdict_fail, got ${status}`);
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
state.verdict = { status, note, by, at: Date.now() };
const tmp = `${file}.tmp`;
writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
renameSync(tmp, file);
console.log(JSON.stringify({ ok: true, file, verdict: state.verdict }, null, 2));
console.log('NOTE: the running process caches the state; restart it (or wait for the next deploy) for the wire to reflect the verdict.');
