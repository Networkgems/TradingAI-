// TRA-3926 — CONTROLS FOR `tra3926-oversold-close-live.mjs`.
//
// That grader's honest reading of the live box is BLIND(3), and it will stay
// BLIND on most runs because the bound's population is held upstream by ruling
// B's authorisation gate. A blind branch that fires on every input is the same
// instrument as no grader at all (TRA-3911's C5, verbatim), so each verdict has
// to be shown REACHABLE against bytes we control.
//
// Method: capture the live pair once, then mutate ONE thing per control and
// require the grader's exit code to move exactly as the mutation predicts.
// Mutating a real capture rather than hand-building a payload is deliberate —
// a hand-built fixture proves the grader can read a shape I invented, not the
// shape the route actually serves.
//
//   C1  untouched capture                    → 3 BLIND   (the bound is unexercised)
//   C2  `oversoldCloses` DELETED             → 1 FAIL    (D1; the presence test can see it ABSENT)
//   C3  `exitQuantityBound` DELETED          → 1 FAIL    (D2)
//   C4  `excessContracts` bumped by 1        → 1 FAIL    (G2; the served column is not trusted)
//   C5  a finding's `engineOpenContracts`→0  → 1 FAIL    (G3/G4; a false accusation is caught)
//   C6  an import_only blind PROMOTED to a finding → 1 FAIL (G6; the exact bug the detector shipped with)
//   C7  `records[]` emptied                  → 3 BLIND   (a cold ledger is never a pass)
//   C8  `checked` forced to 1                → 0 PASS    (the PASS branch is reachable at all)
//   C9  pin commit ≠ --expect                → 3 BLIND   (grades the named build or nothing)
//
// ⚠ C8 is the one that matters most and it is the cheapest to get wrong: with
// the live box permanently at `checked 0`, a grader whose PASS branch was
// unreachable would be indistinguishable from today's correct BLIND.
//
// Usage:  node scripts/tra3926-oversold-close-controls.mjs
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const HOST = 'https://tradingai-bqb1.onrender.com';
const GRADER = new URL('./tra3926-oversold-close-live.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const capture = async path => fetch(`${HOST}${path}`).then(r => r.json()).catch(() => null);
const optionsLive = await capture('/api/health/options-live');
const fee = await capture('/api/health/live-options-fee-slippage');
if (!optionsLive?.build?.commit || !fee?.records) {
  console.error('BLIND — could not capture a live pair to mutate; controls prove nothing without one.');
  process.exit(3);
}
const COMMIT = optionsLive.build.commit.slice(0, 7);
console.log(`# captured ${COMMIT} pid=${optionsLive.build.pid} records=${fee.records.length} findings=${fee.oversoldCloses?.findings?.length ?? '—'}`);

const clone = o => JSON.parse(JSON.stringify(o));
const root = mkdtempSync(join(tmpdir(), 'tra3926-controls-'));
let failed = 0;

const run = (name, expectExit, mutate, expectSha = COMMIT) => {
  const ol = clone(optionsLive);
  const fs2 = clone(fee);
  mutate(ol, fs2);
  const dir = mkdtempSync(join(root, 'c-'));
  writeFileSync(join(dir, 'options-live.json'), JSON.stringify(ol));
  writeFileSync(join(dir, 'fee-slippage.json'), JSON.stringify(fs2));
  const r = spawnSync(process.execPath, [GRADER, `--fixture=${dir}`, `--expect=${expectSha}`], { encoding: 'utf8' });
  const ok = r.status === expectExit;
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}  — expected exit ${expectExit}, got ${r.status}`);
  if (!ok) console.log((r.stdout + r.stderr).split('\n').filter(l => /FAIL|BLIND|PASS/.test(l)).slice(0, 6).map(l => `        ${l}`).join('\n'));
};

run('C1  untouched capture → BLIND (bound unexercised)', 3, () => {});
run('C2  `oversoldCloses` DELETED → FAIL', 1, (ol, f) => { delete f.oversoldCloses; });
run('C3  `exitQuantityBound` DELETED → FAIL', 1, ol => { delete ol.exitQuantityBound; });
run('C4  served `excessContracts` +1 → FAIL', 1, (ol, f) => { f.oversoldCloses.excessContracts += 1; });
run('C5  a finding\'s engineOpenContracts → 0 → FAIL', 1, (ol, f) => {
  if (f.oversoldCloses.findings.length === 0) throw new Error('no finding to corrupt');
  f.oversoldCloses.findings[0].engineOpenContracts = 0;
});
run('C6  an import_only blind PROMOTED to a finding → FAIL', 1, (ol, f) => {
  const b = f.oversoldCloses.blindCloses.find(x => x.reason === 'import_only');
  if (!b) throw new Error('no import_only blind to promote');
  f.oversoldCloses.blindCloses = f.oversoldCloses.blindCloses.filter(x => x !== b);
  f.oversoldCloses.findings.push({
    optionSymbol: b.optionSymbol, ts: b.ts, etDay: '2026-08-21', orderId: 1,
    soldContracts: b.soldContracts, engineOpenContracts: 0,
    importedOpenContracts: b.importedOpenContracts, excessContracts: b.soldContracts,
  });
  f.oversoldCloses.excessContracts += b.soldContracts;
  f.oversoldCloses.judgedCloses += 1;
});
run('C7  `records[]` emptied → BLIND (a cold ledger is never a pass)', 3, (ol, f) => { f.records = []; });
run('C8  `exitQuantityBound.checked` = 1 → PASS (the pass branch is REACHABLE)', 0, ol => {
  ol.exitQuantityBound = { ...ol.exitQuantityBound, checked: 1, bounded: 1, refusedContracts: 1 };
});
run('C9  pin commit ≠ --expect → BLIND', 3, () => {}, 'deadbee');

rmSync(root, { recursive: true, force: true });
console.log(failed === 0 ? '\nCONTROLS PASS — every verdict is reachable and each is reached for its own reason.'
  : `\nCONTROLS FAIL — ${failed} control(s) did not move as predicted.`);
process.exit(failed === 0 ? 0 : 1);
