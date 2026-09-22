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
//   C14–C18 grant partition (2026-08-26): bytes-absent / RIG promotion / G10's two limbs / PASS reachable
//   C19 an `anchor` grant the grader does not pin → 1 FAIL (G10; an anchor added to quiet a finding is caught)
//   C4a/C14a the two INJECTED bases, UNMUTATED → 0 PASS (each red below is the mutation's, not the base's)
//   C6b a symbol whose closes straddle BOTH blind buckets → 0 PASS (the 2026-09-22 false FAIL)
//   C6c a blind served `import_only` whose import POSTDATES the close → 1 FAIL (G6b still discriminates)
//   C6d a pinned aged-out anchor silently dropped → 1 FAIL (an anchor may degrade; it may not vanish)
//
// ⚠ THE CONTROLS' OWN FIXTURES EVAPORATE (2026-09-22). C5/C6/C15/C16/C17/C19
// mutated whatever finding or grant the LIVE capture held. The 30-day horizon
// crossed the last engine open in the population, the census went `clean` with
// zero findings and zero grants, and C5 THREW — taking C6..C19 down with it.
// The suite that keeps the grader honest ran 4 of 20 on the one beat it was
// built for, and reported no failure while doing it. Controls must never take
// their premise from the subject's current contents: `synth` and `synthGrant`
// inject their own self-consistent episodes, each graded GREEN unmutated first.
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
// TRA-3926 (2026-08-26) — and the GRANT PARTITION on a capture that predates
// it. A pre-partition box serves no `grantedCloses` / `grantedContracts` and
// files the desk's granted `RIG260925C00006000` close (order 143384264, sold
// under the board's `desk_add` exemption) as a FINDING; seeded here the way the
// two blocks above are, so every control below sees the partition's shape. The
// live grader's D7 FAILS on such a box — that is its negative control.
if (fee.oversoldCloses && !('grantedCloses' in fee.oversoldCloses)) {
  const rig = fee.oversoldCloses.findings.find(x => x.orderId === 143384264);
  if (rig) {
    fee.oversoldCloses.findings = fee.oversoldCloses.findings.filter(x => x !== rig);
    fee.oversoldCloses.excessContracts -= rig.excessContracts;
    fee.oversoldCloses.grantedCloses = [{ ...rig, grant: 'desk_add', grantSource: 'anchor' }];
    fee.oversoldCloses.grantedContracts = rig.excessContracts;
  } else {
    fee.oversoldCloses.grantedCloses = [];
    fee.oversoldCloses.grantedContracts = 0;
  }
  console.log(`# PRE-DEPLOY capture — \`grantedCloses\` / \`grantedContracts\` SEEDED (${rig ? 'RIG 143384264 → desk_add/anchor' : 'empty; no RIG finding in the capture'}) `
    + 'so the controls can grade the grader; the live grader\'s D7 still fails on this box and that is the negative control.');
}
// TRA-3926 (2026-09-03) — a capture from the PRE-ANCHOR partition build: the
// keys are present but RIG 143384264 is ACCUSED, because its closed row was
// archived before the partition ever deployed and the `closed_row` fallback
// can never answer for the pre-cut population. Re-partitioned here to the
// anchor shape the fixed build serves; the live grader's R4 still FAILS on
// this box and that is the negative control that found the defect.
if (fee.oversoldCloses && 'grantedCloses' in fee.oversoldCloses) {
  const rig = fee.oversoldCloses.findings.find(x => x.orderId === 143384264);
  if (rig && !fee.oversoldCloses.grantedCloses.some(x => x.orderId === 143384264)) {
    fee.oversoldCloses.findings = fee.oversoldCloses.findings.filter(x => x !== rig);
    fee.oversoldCloses.excessContracts -= rig.excessContracts;
    fee.oversoldCloses.grantedCloses.push({ ...rig, grant: 'desk_add', grantSource: 'anchor' });
    fee.oversoldCloses.grantedContracts += rig.excessContracts;
    console.log('# PRE-ANCHOR capture — RIG 143384264 was ACCUSED (closed row archived before the partition deployed); '
      + 're-partitioned to desk_add/anchor so the controls can grade the grader. The live grader\'s R4 still fails on this box.');
  }
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
// ⛔ TRA-3926 (2026-09-22) — THE CONTROLS' OWN FIXTURES EVAPORATE WITH THE TAPE.
// C5 and C6 mutated whatever finding / `import_only` blind the LIVE capture
// happened to hold. On 2026-09-22 the 30-day horizon crossed the last engine
// open in the population and the live census went `clean` with ZERO findings —
// C5 threw `no finding to corrupt` and took C6..C13 down with it, so the suite
// that keeps the grader honest was silently 4/13 on the beat it was needed.
// The controls must not depend on the tape carrying a defect; they inject their
// own self-consistent episode and mutate THAT.
// ⚠ The injected base is graded GREEN first (C4a/C5a below). A positive control
// that reds for a STRONGER reason than its mutation is vacuous — if the base
// itself did not agree with the order-free fold, C5's red would prove nothing
// about `engineOpenContracts` (TRA-3897's hook, and it applies to me here).
const SYNTH_OVERSOLD = 'CTL260925C00001000';
const SYNTH_IMPORT = 'CTL260925C00002000';
const synth = (ol, f) => {
  const base = Math.max(...f.records.map(r => r.ts).filter(Number.isFinite));
  const push = (optionSymbol, side, contracts, origin, orderId, ts) =>
    f.records.push({ ts, optionSymbol, side, contracts, origin, orderId, exitGrant: null });
  // an ENGINE 2-lot closed for 3 — a coherent excess of exactly 1
  push(SYNTH_OVERSOLD, 'buy_to_open', 2, 'fill', 900000001, base - 7200000);
  push(SYNTH_OVERSOLD, 'sell_to_close', 3, 'fill', 900000002, base - 3600000);
  f.oversoldCloses.findings.push({
    optionSymbol: SYNTH_OVERSOLD, ts: base - 3600000, etDay: '2026-09-22', orderId: 900000002,
    soldContracts: 3, engineOpenContracts: 2, engineOpensSeenContracts: 2,
    importedOpenContracts: 0, excessContracts: 1, basis: 'outstanding',
  });
  f.oversoldCloses.excessContracts += 1;
  f.oversoldCloses.judgedCloses += 1;
  f.oversoldCloses.engineCloses += 1;
  f.oversoldCloses.status = 'oversold';
  // a DESK import closed by the engine — a coherent `import_only` blind
  push(SYNTH_IMPORT, 'buy_to_open', 1, 'history_import', null, base - 7200000);
  push(SYNTH_IMPORT, 'sell_to_close', 1, 'fill', 900000003, base - 3600000);
  f.oversoldCloses.blindCloses.push({
    optionSymbol: SYNTH_IMPORT, ts: base - 3600000, reason: 'import_only',
    soldContracts: 1, importedOpenContracts: 1,
  });
  f.oversoldCloses.engineCloses += 1;
  // the bound must read EXERCISED or the verdict is BLIND(3) and no mutation
  // below can ever be told apart from it.
  ol.exitQuantityBound = {
    ...ol.exitQuantityBound, checked: 1, bounded: 1, refusedContracts: 1, lastRefusalReason: 'engine_partial',
  };
};
run('C4a the INJECTED base alone → PASS (the mutations below red on the mutation, not on the base)', 0, synth);
run('C5  a finding\'s engineOpenContracts → 0 → FAIL', 1, (ol, f) => {
  synth(ol, f);
  f.oversoldCloses.findings.find(x => x.optionSymbol === SYNTH_OVERSOLD).engineOpenContracts = 0;
});
run('C6  an import_only blind PROMOTED to a finding → FAIL', 1, (ol, f) => {
  synth(ol, f);
  const b = f.oversoldCloses.blindCloses.find(x => x.optionSymbol === SYNTH_IMPORT);
  f.oversoldCloses.blindCloses = f.oversoldCloses.blindCloses.filter(x => x !== b);
  f.oversoldCloses.findings.push({
    optionSymbol: b.optionSymbol, ts: b.ts, etDay: '2026-09-22', orderId: 900000003,
    soldContracts: b.soldContracts, engineOpenContracts: 0, engineOpensSeenContracts: 0,
    importedOpenContracts: b.importedOpenContracts, excessContracts: b.soldContracts, basis: 'exhausted',
  });
  f.oversoldCloses.excessContracts += b.soldContracts;
  f.oversoldCloses.judgedCloses += 1;
});
// ⛔ THE HORIZON REGRESSION ITSELF, as a control. Both are cases the pre-fix
// grader got WRONG in opposite directions on 2026-09-22, and both must stay
// graded: C6b is the one that red a correct route (a symbol whose closes
// straddle two blind buckets), C6c is the one a reason-blind relaxation would
// let through (a blind whose served reason contradicts the import's own ts).
run('C6b a symbol with closes in BOTH blind buckets → PASS (the per-close split, not a symbol set)', 0, (ol, f) => {
  synth(ol, f);
  const base = Math.max(...f.records.map(r => r.ts).filter(Number.isFinite));
  // a close BEFORE the desk import, so the same OCC holds one of each reason
  f.records.push({ ts: base - 10800000, optionSymbol: SYNTH_IMPORT, side: 'sell_to_close', contracts: 1, origin: 'fill', orderId: 900000004, exitGrant: null });
  f.oversoldCloses.blindCloses.push({
    optionSymbol: SYNTH_IMPORT, ts: base - 10800000, reason: 'no_open_record', soldContracts: 1, importedOpenContracts: 0,
  });
  f.oversoldCloses.engineCloses += 1;
});
run('C6c a blind served `import_only` whose import POSTDATES the close → FAIL (G6b)', 1, (ol, f) => {
  synth(ol, f);
  const base = Math.max(...f.records.map(r => r.ts).filter(Number.isFinite));
  f.records.push({ ts: base - 10800000, optionSymbol: SYNTH_IMPORT, side: 'sell_to_close', contracts: 1, origin: 'fill', orderId: 900000004, exitGrant: null });
  f.oversoldCloses.blindCloses.push({
    optionSymbol: SYNTH_IMPORT, ts: base - 10800000, reason: 'import_only', soldContracts: 1, importedOpenContracts: 1,
  });
  f.oversoldCloses.engineCloses += 1;
});
// ⛔ THE ANCHOR'S OWN HAZARD, now that it accepts EITHER aged-out reason: a
// pinned close whose witness is gone must still be SERVED. Silence is the
// failure mode the durable carrier exists for, and it must red here.
run('C6d a pinned aged-out anchor SILENTLY DROPPED from blindCloses → FAIL (R: the row vanished)', 1, (ol, f) => {
  synth(ol, f);
  f.oversoldCloses.blindCloses = f.oversoldCloses.blindCloses
    .filter(x => x.optionSymbol !== 'BAC260925C00063000');
  f.oversoldCloses.engineCloses -= 1;
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

// TRA-3926 (2026-08-26) — the GRANT partition (seeded on a pre-partition
// capture at the top of this file, the way D5/D6 are). The permissive direction
// is the one that matters: a route that hides a finding by calling it granted.
// C15 pins the RIG anchor (a `closed_row` grant the grader cannot verify from
// the tape, so the anchor is the only thing that catches its promotion); C16 and
// C17 are G10's two limbs; C18 proves the partition's PASS branch is reachable.
run('C14 `grantedCloses` DELETED → FAIL (D7 sees the partition\'s bytes ABSENT)', 1, (ol, f) => {
  ol.exitQuantityBound = { ...ol.exitQuantityBound, checked: 1, bounded: 1, refusedContracts: 1, lastRefusalReason: 'engine_partial' };
  delete f.oversoldCloses.grantedCloses;
});
// ⛔ TRA-3926 (2026-09-22) — THE ANCHOR LIMB EVAPORATED TOO. RIG's engine open
// crossed the horizon this beat, so the route (correctly) degraded its grant to
// a blind and `grantedCloses` went empty — C15 threw and took C16..C19 with it.
// `synthGrant` puts RIG's engine open back in the tape, which is the ONLY thing
// the horizon removed, and re-partitions the census to the shape the route
// served while that open was still derivable. It grants nothing the grader does
// not already pin: 143384264 is in KNOWN_GRANTED and its record stays UNSTAMPED,
// so G10's `anchor` limb is exercised for real.
const synthGrant = (ol, f) => {
  const base = Math.min(...f.records.map(r => r.ts).filter(Number.isFinite));
  f.records.push({ ts: base - 3600000, optionSymbol: 'RIG260925C00006000', side: 'buy_to_open',
    contracts: 1, origin: 'fill', orderId: 900000020, exitGrant: null });
  const oc = f.oversoldCloses;
  const dropped = oc.blindCloses.filter(x => x.optionSymbol === 'RIG260925C00006000');
  oc.blindCloses = oc.blindCloses.filter(x => x.optionSymbol !== 'RIG260925C00006000');
  oc.judgedCloses += dropped.length;
  oc.grantedCloses.push({
    optionSymbol: 'RIG260925C00006000', ts: Date.parse('2026-08-26T13:45:31.275Z'), etDay: '2026-08-26',
    orderId: 143384264, soldContracts: 1, engineOpenContracts: 0, engineOpensSeenContracts: 1,
    importedOpenContracts: 1, excessContracts: 1, basis: 'exhausted',
    grant: 'desk_add', grantSource: 'anchor',
  });
  oc.grantedContracts += 1;
  ol.exitQuantityBound = { ...ol.exitQuantityBound, checked: 1, bounded: 1, refusedContracts: 1, lastRefusalReason: 'engine_partial' };
};
run('C14a the INJECTED grant base alone → PASS (C15 reds on the promotion, not on the base)', 0, synthGrant);
run('C15 the RIG grant PROMOTED back to a finding → FAIL (the granted anchor is accused)', 1, (ol, f) => {
  synthGrant(ol, f);
  const g = f.oversoldCloses.grantedCloses.find(x => x.orderId === 143384264);
  f.oversoldCloses.grantedCloses = f.oversoldCloses.grantedCloses.filter(x => x !== g);
  f.oversoldCloses.grantedContracts -= g.excessContracts;
  // TRA-4440 — bindings renamed, keys unchanged: `...finding` still strips `grant`
  // and `grantSource`, which is what demotes the granted row back to a finding.
  const { grant: _grant, grantSource: _grantSource, ...finding } = g;
  f.oversoldCloses.findings.push(finding);
  f.oversoldCloses.excessContracts += finding.excessContracts;
});
// C16/C17/C19 demote the INJECTED finding (900000002), not XLF 142806015 —
// XLF's whole episode left the tape on 2026-09-19 and its finding with it.
run('C16 a FINDING demoted to `record`-granted with NO stamp on its record → FAIL (G10: unbacked grant)', 1, (ol, f) => {
  synth(ol, f);
  const x = f.oversoldCloses.findings.find(z => z.orderId === 900000002);
  f.oversoldCloses.findings = f.oversoldCloses.findings.filter(z => z !== x);
  f.oversoldCloses.excessContracts -= x.excessContracts;
  f.oversoldCloses.grantedCloses.push({ ...x, grant: 'desk_add', grantSource: 'record' });
  f.oversoldCloses.grantedContracts += x.excessContracts;
});
run('C17 a FINDING demoted to `closed_row`-granted while its record says `none` → FAIL (G10: a stamped record is final)', 1, (ol, f) => {
  synth(ol, f);
  const x = f.oversoldCloses.findings.find(z => z.orderId === 900000002);
  const rec = f.records.find(r => r.orderId === 900000002);
  rec.exitGrant = 'none';
  f.oversoldCloses.findings = f.oversoldCloses.findings.filter(z => z !== x);
  f.oversoldCloses.excessContracts -= x.excessContracts;
  f.oversoldCloses.grantedCloses.push({ ...x, grant: 'desk_add', grantSource: 'closed_row' });
  f.oversoldCloses.grantedContracts += x.excessContracts;
});
// TRA-3926 (2026-09-03) — the anchor's own permissive limb: an `anchor` grant
// served for an order this grader does NOT pin in KNOWN_GRANTED is UNBACKED.
// Without this, adding a row to the ROUTE's anchor table to quiet a finding
// would sail through — the deleted alarm wearing the anchor's name.
run('C19 a FINDING demoted to `anchor`-granted for an order the grader does not pin → FAIL (G10: unbacked anchor)', 1, (ol, f) => {
  synth(ol, f);
  const x = f.oversoldCloses.findings.find(z => z.orderId === 900000002);
  f.oversoldCloses.findings = f.oversoldCloses.findings.filter(z => z !== x);
  f.oversoldCloses.excessContracts -= x.excessContracts;
  f.oversoldCloses.grantedCloses.push({ ...x, grant: 'desk_add', grantSource: 'anchor' });
  f.oversoldCloses.grantedContracts += x.excessContracts;
});
run('C18 the partition untouched, with the bound exercised → PASS (the grant partition\'s pass branch is REACHABLE)', 0, ol => {
  ol.exitQuantityBound = { ...ol.exitQuantityBound, checked: 1, bounded: 1, refusedContracts: 1, lastRefusalReason: 'engine_partial' };
});

rmSync(root, { recursive: true, force: true });
console.log(failed === 0 ? '\nCONTROLS PASS — every verdict is reachable and each is reached for its own reason.'
  : `\nCONTROLS FAIL — ${failed} control(s) did not move as predicted.`);
process.exit(failed === 0 ? 0 : 1);
