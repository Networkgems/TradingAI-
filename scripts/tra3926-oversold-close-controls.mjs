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
//   C1  census forced to ZERO                → 3 BLIND   (an unexercised bound is never a pass)
//   C2  `oversoldCloses` DELETED             → 1 FAIL    (D1; the presence test can see it ABSENT)
//   C3  `exitQuantityBound` DELETED          → 1 FAIL    (D2)
//   C4  `excessContracts` bumped by 1        → 1 FAIL    (G2; the served column is not trusted)
//   C5  a finding's `engineOpenContracts`→0  → 1 FAIL    (G3/G4; a false accusation is caught)
//   C6  an import_only blind PROMOTED to a finding → 1 FAIL (G6; the exact bug the detector shipped with)
//   C7  `records[]` emptied                  → 3 BLIND   (a cold ledger is never a pass)
//   C8  `checked` forced to 1, last refusal a FINDING → 0 PASS (the PASS branch is reachable at all)
//   C9  pin commit ≠ --expect                → 3 BLIND   (grades the named build or nothing)
//   C10 `deskAddExempt` DELETED              → 1 FAIL    (D5; the carve-out's bytes can be seen absent)
//   C11 last refusal = `foreign_authority`   → 1 FAIL    (G9; the two gates disagreeing is caught)
//   C12 `outstanding` DELETED                → 1 FAIL    (D6; the durable block's bytes can be seen absent)
//   C13 census ZERO but `outstanding` = 1 row → 3 BLIND, AND the verdict names the outstanding refusal
//                                                        (the post-restart shape of 2026-08-25 cannot read as calm)
//
// ⚠ C8 is the one that matters most and it is the cheapest to get wrong: with
// the live box at `checked 0`, a grader whose PASS branch was unreachable would
// be indistinguishable from a correct BLIND.
//
// ⚠ C1 USED TO BE "untouched capture → BLIND". That encoded the day's arithmetic
// (`checked 0`) as the expected verdict, and it went RED on 2026-08-25 the first
// time the box exercised the bound — a control whose verdict moves with the
// subject is a measurement, not a control (TRA-3911 C5, TRA-3913 C5, same
// lesson a third time). Both limbs are now CONSTRUCTED: C1 forces the census to
// zero, C8 forces it non-zero, and neither reads today's box for its premise.
//
// ⚠ PRE-DEPLOY CAPTURES. A box that predates the desk_add carve-out serves no
// `deskAddExempt` / `lastRefusalReason`. The controls grade the GRADER, so they
// SEED those two keys on such a capture (bannered) — D5 on the real box is the
// live grader's job, and it FAILS there, which is the negative control.
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
if (optionsLive.exitQuantityBound && !('deskAddExempt' in optionsLive.exitQuantityBound)) {
  optionsLive.exitQuantityBound.deskAddExempt = 0;
  optionsLive.exitQuantityBound.lastRefusalReason = null;
  console.log('# PRE-DEPLOY capture — `deskAddExempt` / `lastRefusalReason` SEEDED so the controls can grade the grader; '
    + 'the live grader\'s D5 still fails on this box and that is the negative control.');
}
// TRA-3926 (2026-08-26) — same seeding for the DURABLE block on a capture that
// predates it. The live grader's D6 FAILS on such a box; that is its negative
// control, and these controls grade the grader, not the box.
if (optionsLive.exitQuantityBound && !('outstanding' in optionsLive.exitQuantityBound)) {
  optionsLive.exitQuantityBound.outstanding = { rows: 0, refusedContracts: 0, latestAt: null, latestReason: null };
  console.log('# PRE-DEPLOY capture — `outstanding` SEEDED so the controls can grade the grader; '
    + 'the live grader\'s D6 still fails on this box and that is the negative control.');
}
const ZERO_CENSUS = {
  checked: 0, bounded: 0, refusedContracts: 0, blindRows: 0, suppressedExits: 0, netOfCloses: 0,
  deskAddExempt: 0, lastRefusalAt: null, lastRefusalReason: null,
  outstanding: { rows: 0, refusedContracts: 0, latestAt: null, latestReason: null },
};

const clone = o => JSON.parse(JSON.stringify(o));
const root = mkdtempSync(join(tmpdir(), 'tra3926-controls-'));
let failed = 0;

// `expectOut` — an optional regex the grader's COMBINED output must match. The
// exit code alone cannot tell "BLIND and named the outstanding refusal" from
// "BLIND and read as calm", and the second is the defect C13 exists to catch.
const run = (name, expectExit, mutate, expectSha = COMMIT, expectOut = null) => {
  const ol = clone(optionsLive);
  const fs2 = clone(fee);
  mutate(ol, fs2);
  const dir = mkdtempSync(join(root, 'c-'));
  writeFileSync(join(dir, 'options-live.json'), JSON.stringify(ol));
  writeFileSync(join(dir, 'fee-slippage.json'), JSON.stringify(fs2));
  const r = spawnSync(process.execPath, [GRADER, `--fixture=${dir}`, `--expect=${expectSha}`], { encoding: 'utf8' });
  const out = r.stdout + r.stderr;
  const exitOk = r.status === expectExit;
  const outOk = expectOut === null || expectOut.test(out);
  const ok = exitOk && outOk;
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}  — expected exit ${expectExit}, got ${r.status}`
    + (expectOut === null ? '' : `; output ${outOk ? 'names' : 'DOES NOT name'} ${expectOut}`));
  if (!ok) console.log(out.split('\n').filter(l => /FAIL|BLIND|PASS|OUTSTANDING/.test(l)).slice(0, 6).map(l => `        ${l}`).join('\n'));
};

run('C1  census forced to ZERO → BLIND (an unexercised bound is never a pass)', 3, ol => {
  ol.exitQuantityBound = { ...ol.exitQuantityBound, ...ZERO_CENSUS };
});
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
run('C8  `exitQuantityBound.checked` = 1, last refusal a FINDING → PASS (the pass branch is REACHABLE)', 0, ol => {
  ol.exitQuantityBound = {
    ...ol.exitQuantityBound, checked: 1, bounded: 1, refusedContracts: 1, lastRefusalReason: 'engine_partial',
  };
});
run('C9  pin commit ≠ --expect → BLIND', 3, () => {}, 'deadbee');
run('C10 `deskAddExempt` DELETED → FAIL (D5 sees the carve-out\'s bytes ABSENT)', 1, ol => {
  ol.exitQuantityBound = { ...ol.exitQuantityBound, checked: 1, bounded: 1, refusedContracts: 1, lastRefusalReason: 'engine_partial' };
  delete ol.exitQuantityBound.deskAddExempt;
});
run('C11 last refusal = `foreign_authority` with the bound exercised → FAIL (G9: the gates disagree)', 1, ol => {
  ol.exitQuantityBound = {
    ...ol.exitQuantityBound, checked: 245, bounded: 245, refusedContracts: 245, suppressedExits: 245,
    deskAddExempt: 0, lastRefusalReason: 'foreign_authority',
  };
});
run('C12 `outstanding` DELETED → FAIL (D6 sees the durable block\'s bytes ABSENT)', 1, ol => {
  ol.exitQuantityBound = { ...ol.exitQuantityBound, checked: 1, bounded: 1, refusedContracts: 1, lastRefusalReason: 'engine_partial' };
  delete ol.exitQuantityBound.outstanding;
});
// The 2026-08-25 post-restart shape, byte for byte: counters zero, one durable
// `foreign_authority` stamp on an open row. The verdict must stay BLIND (an
// unexercised bound is still not a pass) AND must NAME the outstanding refusal
// — a BLIND that reads as calm is the defect QuantTrader measured twice.
run('C13 census ZERO + `outstanding` 1 row → BLIND that NAMES the outstanding refusal', 3, ol => {
  ol.exitQuantityBound = {
    ...ol.exitQuantityBound, ...ZERO_CENSUS,
    outstanding: { rows: 1, refusedContracts: 1, latestAt: Date.parse('2026-08-25T19:58:16.789Z'), latestReason: 'foreign_authority' },
  };
}, COMMIT, /NOT a quiet bound: 1 row\(s\) \/ 1 contract\(s\), latest 2026-08-25T19:58:16\.789Z foreign_authority/);

rmSync(root, { recursive: true, force: true });
console.log(failed === 0 ? '\nCONTROLS PASS — every verdict is reachable and each is reached for its own reason.'
  : `\nCONTROLS FAIL — ${failed} control(s) did not move as predicted.`);
process.exit(failed === 0 ? 0 : 1);
