#!/usr/bin/env node
// TRA-2306 — grade TRA-2295's directional spread ceiling on its first live session.
//
// WHY THIS IS A SCRIPT AND NOT A CHECKLIST
// ----------------------------------------
// The grading procedure for this one verdict has already been corrected SIX times in the issue
// description (wrong `byStructure` object · `null <= 0.10` false-pass · `rows=demo` hides open
// rows · structure-only over-select · archetype-only under-protect · `.gated` vs `.ungated` on the
// pinned control). Every one of those was a case where the payload reads IDENTICALLY in the pass
// state and the broken state, and a careful human grader still got it wrong by reading top-down.
// Prose cannot fail closed. This can, and it self-tests. Same reasoning as TRA-2339's checker
// (`e8bf36c`): ship the checker, not a dated green.
//
//   node scripts/tra2306-ceiling-grade.mjs              # grade live bqb1
//   node scripts/tra2306-ceiling-grade.mjs --self-test   # prove every branch fires
//   node scripts/tra2306-ceiling-grade.mjs --dir=.       # grade captured .2306-*.json
//
// Exit: 0 PASS · 1 FAIL · 2 VOID · 3 NOT_GRADED_YET · 4 BLIND (never conflate with PASS)

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const HOST = process.env.BQB1_HOST ?? 'https://tradingai-bqb1.onrender.com';
const STRUCT = 'single_leg_directional'; // NOT `directional` — that row is cost-bar/delta only
const ARCHETYPE = 'directional';
const DESK = new Set(['admin', 'Richard']);
const CEILING = 0.1;
const MIN_BID = 0.1;

// ── Pinned controls ───────────────────────────────────────────────────────────
// Re-measured live 2026-07-26 at SHA 408f06a5 (process startedAt 2026-07-26T01:44:11.363Z),
// basis rows=all. These reproduce the description's pins taken at SHA 7161d2be, i.e. they
// SURVIVED that SHA move — so a mismatch on Monday means the instrument changed, not that the
// pin was stale.
//
// The negative control lives at `.ungated` on purpose: `single_leg_rv` is `gatedArchetypes:
// "none"` (its filter sits inside the compile-time-dead RV scanner, TRA-2193b), so its `.gated`
// reads n=0/all-null. A grader applying "grade .gated" uniformly to the control reads n=0 and
// HALTS — a false halt that looks exactly like due diligence. Encoded so it cannot recur.
export const CONTROLS = {
  negative: { structure: 'single_leg_rv', arm: 'ungated', n: 87, countAboveCeiling: 63, maxSpreadPct: 1.9333333333333333, countBelowMinBid: 6 },
  positive: { structure: 'single_leg_otm', arm: 'gated', n: 28, countAboveCeiling: 0, maxSpreadPct: 0.19607843137254907, countBelowMinBid: 0 },
};

const num = v => typeof v === 'number' && Number.isFinite(v);
const row = (rows, structure) => (rows ?? []).find(r => r?.structure === structure);

// ── BUILD IDENTITY: a SECOND, NAME-INDEPENDENT TRA-2355 detector ─────────────
// The payload detector below tests for a KEY NAME I PREDICTED. TRA-2355 is unwritten and
// undeployed; its author does not owe me `spreadCeilingByAccountClass`, and if the axis lands as
// `byBook` / `accounts` / `deskAdmitted` the name-pinned detector reads NEGATIVE and the grade
// proceeds against a re-keyed tally. So pin the BUILD, not the vocabulary: `204f298` either is or
// is not an ancestor of the live SHA, whatever it named its fields.
//
// Direction matters. `true` VOIDs (an instrument change is real whatever produced it). `null` —
// git could not answer, or `--dir=` mode has no live SHA — SUPPRESSES THE PASS DIRECTION ONLY and
// never manufactures a verdict, the same direction-scoped stop rev 12 imposed on the prose.
export const TRA2355_COMMIT = '204f298';
export function readBuild({ liveSha = null, isAncestor = null } = {}) {
  const out = { liveSha, tra2355: isAncestor, notes: [] };
  if (isAncestor === true) out.notes.push(`TRA-2355 (${TRA2355_COMMIT}) IS AN ANCESTOR of live ${liveSha} — the tally was re-keyed under the grade, whatever the payload calls it`);
  if (isAncestor === null) out.notes.push(`BUILD IDENTITY UNKNOWN — could not test whether TRA-2355 (${TRA2355_COMMIT}) is in live ${liveSha ?? '(no SHA read)'}; the second detector did NOT run. Suppresses the PASS direction only.`);
  return out;
}

function tra2355IsLive(liveSha) {
  if (!liveSha) return null;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', TRA2355_COMMIT, liveSha], { stdio: 'ignore' });
    return true;
  } catch (e) {
    // Exit 1 = a clean "not an ancestor". Anything else (unknown SHA, no git, not a repo) is an
    // UNANSWERED question and must not be read as "absent" — that is the fail-open this whole
    // ticket exists to prevent.
    return e?.status === 1 ? false : null;
  }
}

// ── READ 1: /api/health/cost-aware-gate ──────────────────────────────────────
export function read1(cag) {
  const out = { armed: cag?.spreadCeiling?.armed, evaluated: null, maxAdmitted: undefined, present: false, instrumentChanged: false, accountAxis: false, publishedKey: null, keyDiverged: false, keyUnverified: false, notes: [] };

  // ── THE GRADER'S OWN COPY OF THE STRUCTURE KEY (TRA-2345, wired in 2026-07-26) ──
  // `STRUCT` above is a THIRD copy of `DIRECTIONAL_STRUCTURE_LABEL`. TRA-2345 (`005980d`)
  // de-duplicated the server's two copies — the recorder's key and the payload's doc field now
  // interpolate ONE exported constant — but it could not reach this file, which is out-of-process
  // and greps the key over HTTP. So the divergence TRA-2345 closed is still OPEN here, just
  // relocated to the grader: rename the constant and the server stays perfectly coherent while
  // THIS script looks up a key nobody writes, finds no row, and reports `absent -> VOID / the gate
  // did not run` — a MISATTRIBUTED VOID that reads exactly like a quiet session. It cannot
  // manufacture a false PASS, but a silently wrong VOID on the one session this ticket exists to
  // grade costs a week.
  //
  // The fix is to ASSERT against the payload's now-authoritative key, not to ADOPT it: adopting
  // would let a corrupt field silently redirect the grade onto the wrong row, and would decouple
  // this read from READ 2/READ 3 and the pinned controls, which all key off `STRUCT` too. Pin the
  // constant, detect the divergence. Same discipline as the build detector above.
  //
  // ⚠ EXACT TOKEN, never `startsWith`. The field is `<key> — <prose>`, so `startsWith(STRUCT)`
  // returns TRUE for a SUFFIX rename (`single_leg_directional_v2`) — the detector would read
  // identically in the matched and diverged state, which is this ticket's own defect family
  // turned on its checker. Split on whitespace and compare the first token.
  //
  // Negative control: measured live 2026-07-26 06:31Z at SHA 408f06a5 (PRE-TRA-2345, i.e. the
  // hardcoded literal), the field is PRESENT and its first token is exactly `single_leg_directional`.
  // It reads the same after 005980d deploys, because that commit changed the plumbing and not the
  // value — so this check is compatible with both builds and cannot fire spuriously on the deploy.
  const published = cag?.spreadCeilingStructureKeys?.demo_directional;
  if (typeof published !== 'string') {
    // A doc field, so its ABSENCE is not itself proof the key moved — but it does mean the
    // cross-check did not run. Suppress the PASS direction only; never invent a VOID or a FAIL.
    out.keyUnverified = true;
    out.notes.push(`spreadCeilingStructureKeys.demo_directional ABSENT — cannot cross-check the graded key \`${STRUCT}\` against the key the recorder writes under (TRA-2345). Suppresses the PASS direction only.`);
  } else {
    out.publishedKey = published.trim().split(/\s/)[0];
    if (out.publishedKey !== STRUCT) {
      out.keyDiverged = true;
      out.notes.push(`STRUCTURE KEY DIVERGED — the payload names \`${out.publishedKey}\` as the directional ceiling row, this grade reads \`${STRUCT}\`. The recorder writes under the payload's key (TRA-2345), so every READ here is looking at a row nobody fills. NOT a quiet session.`);
    }
  }

  // TRA-2355 free deploy detector, widened 2026-07-26 from the two guessed key names to the
  // PROPERTY: does READ 1 carry an account axis at all? Pinned negative control — the substring
  // `account` occurs 0 times in 4,518 chars of this payload at SHA 408f06a5. So ANY occurrence is
  // a change to this instrument, and fail-closed (VOID) is the right direction for a false
  // positive. If it appears, the tally was re-keyed MID-GRADE: pre-2355 records hydrate as
  // `unattributed`, never `desk`. That is an instrument change, not a data change.
  const blob = JSON.stringify(cag ?? {});
  if (/account/i.test(blob)) {
    out.instrumentChanged = true;
    out.accountAxis = true;
    out.notes.push('TRA-2355 account axis is LIVE — the tally was re-keyed under the grade (deploy hold breached)');
  }

  // `retained.byStructure` folds every retained ET day INCLUDING the in-flight one. Top-level
  // `.byStructure` is `byDay.get(etDay)` — current ET day only, and measured `[]` on a quiet day.
  // Two objects, same schema, same name. Grade `retained`.
  const r = row(cag?.retained?.byStructure, STRUCT);
  if (!r) { out.notes.push(`retained.byStructure[${STRUCT}] ABSENT — rows materialise lazily, so absent !== 0, but both are VOID`); return out; }
  out.present = true;
  out.evaluated = r.spreadCeilingEvaluated ?? null;
  out.maxAdmitted = r.maxAdmittedSpreadPct; // number | null. null = "admitted nothing", by design.
  return out;
}

// ── READ 2: /api/health/option-spread-cost ceilingCompliance ─────────────────
export function read2(osc) {
  const bac = osc?.ceilingCompliance?.byAccountClass ?? {};
  const cell = (cls, structure) => row(bac[cls], structure);
  const arm = (cls, structure, which) => cell(cls, structure)?.[which] ?? {};
  const out = { desk: arm('desk', STRUCT, 'gated'), fixture: arm('fixture', STRUCT, 'gated'), deskUngated: arm('desk', STRUCT, 'ungated'), notes: [], controls: 'OK' };

  // Partition integrity: holds by construction, so a violation means rows were dropped.
  for (const cls of ['desk', 'fixture']) {
    const c = cell(cls, STRUCT);
    if (!c) continue;
    const g = c.gated?.n ?? 0, u = c.ungated?.n ?? 0;
    if (g + u !== (c.n ?? 0)) out.notes.push(`PARTITION DROPPED ROWS: ${cls}[${STRUCT}] gated ${g} + ungated ${u} !== n ${c.n}`);
    // An archetype absent from `gatedArchetypes` is UNGATED, fail-closed, including `unspecified`.
    if (Array.isArray(c.gatedArchetypes) && !c.gatedArchetypes.includes(ARCHETYPE)) {
      out.notes.push(`${cls}[${STRUCT}].gatedArchetypes ${JSON.stringify(c.gatedArchetypes)} does not include '${ARCHETYPE}'`);
    }
  }

  // Re-pin PER SUB-OBJECT. A control that relocates without changing value is invisible to a
  // value check, so assert the value AT ITS ARM.
  for (const [kind, c] of Object.entries(CONTROLS)) {
    const live = arm('desk', c.structure, c.arm);
    for (const f of ['n', 'countAboveCeiling', 'maxSpreadPct', 'countBelowMinBid']) {
      if (live?.[f] !== c[f]) {
        out.controls = 'MOVED';
        out.notes.push(`CONTROL ${kind} desk[${c.structure}].${c.arm}.${f}: expected ${c[f]}, live ${live?.[f]}`);
      }
    }
  }
  return out;
}

// ── READ 3: /api/health/option-journal?rows=all ──────────────────────────────
// rows=all, NOT rows=demo: demo returns CLOSED rows only, so an entry still OPEN at the read is
// invisible — and an invisible row reads identically to "0 rows above the ceiling", which is the
// expected PASS string here.
export function read3(journal, sinceTs) {
  const rows = journal?.rows ?? [];
  // THE THREE-PART AND IS LOAD-BEARING ON EVERY SIDE.
  //   structure alone OVER-selects: that key is a 3-sleeve pool (gated directional, iv-rv
  //     mispricing, AI-Options-Ideas single-leg). Only the first is gated.
  //   archetype alone UNDER-protects: all 87 pre-fix desk rows are archetype=directional with
  //     structure=single_leg_rv and 63 breach 0.10 — they'd manufacture a false FAIL.
  //   openTs excludes the pre-cutover population (the TRA-2245 label split is forward-only).
  const scoped = rows.filter(r =>
    r?.structure === STRUCT && r?.entryArchetype === ARCHETYPE && DESK.has(r?.account) &&
    (sinceTs == null || num(r?.openTs) && r.openTs >= sinceTs));

  const out = { n: 0, over: 0, thinBid: 0, worst: null, noQuote: 0, axisDisagreement: 0, notes: [] };
  for (const r of scoped) {
    // Compute from the floats. Never from a 2dp rounding.
    const { entryBid: b, entryAsk: a, entryMarkUsd: m } = r;
    if (!num(b) || !num(a) || !num(m) || m <= 0) { out.noQuote++; continue; }
    out.n++;
    const spreadPct = (a - b) / m;
    if (spreadPct > CEILING) out.over++;
    if (b < MIN_BID) out.thinBid++; // the SECOND axis — pre-fix rows failed it 6x. Do not skip it.
    if (out.worst == null || spreadPct > out.worst) out.worst = spreadPct;
  }
  // Forward of the cutover both axes are written in the same object literal, so they agree by
  // construction. A disagreement THERE is itself a finding — report it, never silently pick one
  // axis. BEHIND the cutover they disagree legitimately and en masse (all 87 pre-fix desk rows are
  // archetype=directional / structure=single_leg_rv, because the TRA-2245 label split is
  // forward-only), so running this check without a cutover reports 87 "findings" that are just the
  // known pre-fix population. Not evaluated rather than wrong.
  if (sinceTs == null) {
    out.axisDisagreement = null;
    out.notes.push('axis-disagreement check NOT EVALUATED — pass --since=<deploy ISO> to scope it forward of the TRA-2245 label cutover');
  } else {
    out.axisDisagreement = rows.filter(r =>
      DESK.has(r?.account) && num(r?.openTs) && r.openTs >= sinceTs &&
      ((r?.structure === STRUCT) !== (r?.entryArchetype === ARCHETYPE))).length;
  }
  return out;
}

// ── MASTER VERDICT ORDER: FAIL -> VOID -> NOT_GRADED_YET -> PASS ─────────────
// Evaluated in THIS order, not the order the description's tables are printed in. Every "stop" in
// that document is scoped to the PASS DIRECTION ONLY: nothing may suppress a breach.
export function grade({ r1, r2, r3, build = readBuild() }) {
  const fails = [], voids = [], defers = [], report = [];

  // ── STEP 1: breach tests FIRST, before any denominator or attribution test.
  // The gate is process-wide (one module-level tally keyed (etDay, structure), no account axis),
  // so it gates the fixture engines too. A POOLED breach is a REAL falsification of TRA-2295
  // whichever book carried it: attribution, never suppression.
  if (num(r1.maxAdmitted) && r1.maxAdmitted > CEILING) fails.push(`READ 1 maxAdmittedSpreadPct ${r1.maxAdmitted} > ${CEILING} (pooled — attribute via READ 2, do not suppress)`);
  if (r3.n > 0 && r3.over > 0) fails.push(`journal ${r3.over}/${r3.n} desk rows over ${CEILING} (worst ${r3.worst})`);
  if (r3.n > 0 && r3.thinBid > 0) fails.push(`journal ${r3.thinBid}/${r3.n} desk rows with entryBid < ${MIN_BID} (min-bid axis)`);
  if (r3.n > 0 && r1.evaluated === 0) fails.push(`journal N=${r3.n} while spreadCeilingEvaluated=0 — the gate is NOT on the path the fills came through`);
  if ((r2.desk?.n ?? 0) > 0 && (r2.desk.countAboveCeiling ?? 0) > 0) fails.push(`READ 2 desk.gated ${r2.desk.countAboveCeiling}/${r2.desk.n} over ${CEILING} (max ${r2.desk.maxSpreadPct})`);
  if ((r2.desk?.n ?? 0) > 0 && (r2.desk.countBelowMinBid ?? 0) > 0) fails.push(`READ 2 desk.gated ${r2.desk.countBelowMinBid}/${r2.desk.n} below min bid`);
  // `maxAdmitted === null` means enforcement admitted NOTHING. If the journal nonetheless shows
  // rows, fills bypassed the gate.
  if (r1.present && r1.maxAdmitted === null && r3.n > 0) fails.push(`READ 1 admitted nothing (maxAdmittedSpreadPct null) yet the journal carries ${r3.n} desk rows — fills bypassed the gate`);

  // An `.ungated` breach MUST be reported but falsifies nothing about TRA-2295. Suppressing it
  // would trade the old false FAIL for a false PASS, which is worse.
  if ((r2.deskUngated?.countAboveCeiling ?? 0) > 0) report.push(`desk[${STRUCT}].UNGATED carries ${r2.deskUngated.countAboveCeiling}/${r2.deskUngated.n} over ${CEILING} — REPORT (ungated sleeve, not a TRA-2295 breach)`);
  if (r3.axisDisagreement > 0) report.push(`${r3.axisDisagreement} desk rows FORWARD OF THE CUTOVER where structure and entryArchetype DISAGREE — finding, not a tiebreak`);

  // ── The ABSENT branch, SPOKEN. ──────────────────────────────────────────────
  // The account axis being absent is the state Monday's grade runs in, and until now it produced
  // NO OUTPUT AT ALL — the detector only spoke when the axis APPEARED. A silent absence reads
  // exactly like "checked, fine", which is this ticket's own defect family turned on its checker.
  // Say what the absence MEANS for the verdict, every run.
  if (!r1.accountAxis && build.tra2355 !== true) {
    report.push(`BASIS: READ 1 carries NO account axis (pre-TRA-2355) — `
      + `\`spreadCeilingEvaluated\`/\`maxAdmittedSpreadPct\` are POOLED over every book in the process `
      + `(one module-level tally keyed (etDay, structure); ~51 demo books + the qa_*/ctoverify* fleet). `
      + `They are NOT a desk statement: a non-zero evaluated count does not mean the desk sleeve ran. `
      + `READ 1 may VOID and may FAIL on its own; it can NEVER carry a PASS. The desk axis for this `
      + `grade is READ 2 \`.gated\` + READ 3 — both account-scoped.`);
    // The route's own `comparisonBasis` tells the grader these two should "track" each other. On
    // this build they measure different populations (pooled vs desk), so a divergence is EXPECTED
    // and is not evidence of a lost counter or a lost fill. TRA-2306.
    report.push('BASIS: `ceilingCompliance.comparisonBasis` says READ 1 `maxAdmittedSpreadPct` should track `desk[...].gated.maxSpreadPct`. On a pre-TRA-2355 build those are POOLED vs DESK-ONLY — a divergence is expected and is NOT a finding. Do not resolve it via that note (TRA-2306).');
  }
  report.push(...build.notes, ...r2.notes, ...r1.notes, ...r3.notes);

  // ── STEP 2: VOID — explicitly NOT a pass.
  if (r1.armed === false) voids.push('spreadCeiling.armed === false — DISARMED, grade meaningless, re-open');
  if (r1.instrumentChanged) voids.push('the instrument was re-keyed under the grade (TRA-2355 live — account axis present in the READ 1 payload)');
  // A diverged structure key means every read above looked up a row nobody writes. That is an
  // instrument change, not a quiet session — and it must NOT be reported as "the gate did not run".
  if (r1.keyDiverged) voids.push(`the graded structure key DIVERGED from the one the recorder writes under: payload says \`${r1.publishedKey}\`, this grade read \`${STRUCT}\` (TRA-2345) — re-pin STRUCT and re-run, do NOT read the absent row as a quiet session`);
  if (build.tra2355 === true) voids.push(`the instrument was re-keyed under the grade (TRA-2355 ${TRA2355_COMMIT} is an ancestor of the live build)`);
  if (!r1.present) voids.push(`retained.byStructure[${STRUCT}] absent — the gate did not run`);
  else if (r1.evaluated === 0) voids.push('spreadCeilingEvaluated == 0 — the gate did not run');
  else if (r1.maxAdmitted === null) voids.push('spreadCeilingEvaluated > 0 but admitted NOTHING (maxAdmittedSpreadPct null) — ENFORCED / NO ADMITS, row-level claim VOID, not PASS');
  if (r2.controls === 'MOVED') voids.push('a pinned control MOVED — the instrument changed, do not grade');

  // ── STEP 3: NOT GRADED YET. READ 1 is ACCOUNT-BLIND, so it can VOID and can FAIL on its own,
  // but it can NEVER carry a PASS alone. No PASS is reachable while the desk row count is zero.
  const deskN = r2.desk?.n ?? 0;
  // An UNANSWERED build question is not an answered one. Stops the PASS, never a FAIL or a VOID.
  if (build.tra2355 == null) defers.push(`build identity UNKNOWN — cannot confirm TRA-2355 (${TRA2355_COMMIT}) is ABSENT from the live build`);
  if (r1.keyUnverified) defers.push(`cannot confirm the graded key \`${STRUCT}\` is the key the recorder writes under — spreadCeilingStructureKeys.demo_directional absent (TRA-2345)`);
  if (r3.n === 0) defers.push('journal N == 0 — NOT EVIDENCE');
  if (deskN === 0) {
    defers.push(`READ 2 desk[${STRUCT}].gated.n == 0`);
    if ((r2.fixture?.n ?? 0) > 0) defers.push(`fixture-driven: desk.gated.n == 0 while fixture.gated.n == ${r2.fixture.n} — READ 1's non-zero evaluated count is NOT the desk`);
  }

  const verdict = fails.length ? 'FAIL' : voids.length ? 'VOID' : defers.length ? 'NOT_GRADED_YET' : 'PASS';
  return { verdict, fails, voids, defers, report, exit: { FAIL: 1, VOID: 2, NOT_GRADED_YET: 3, PASS: 0 }[verdict] };
}

// ── self-test ────────────────────────────────────────────────────────────────
// NB the mock's `demo_directional` prose deliberately contains NO `account` substring — the live
// field carries none, and the widened TRA-2355 detector greps the whole payload for one.
const mkCag = (o = {}) => ({
  spreadCeiling: { armed: o.armed ?? true },
  retained: { byStructure: o.absent ? [{ structure: 'directional' }] : [{ structure: STRUCT, spreadCeilingEvaluated: o.evaluated ?? 5, maxAdmittedSpreadPct: 'maxAdmitted' in o ? o.maxAdmitted : 0.08 }] },
  ...(o.noKeys ? {} : { spreadCeilingStructureKeys: { demo_directional: `${o.publishedKey ?? STRUCT} — NOT the \`directional\` row (TRA-2295).`, otm: 'single_leg_otm — gated in the OTM scanner chain filter.' } }),
  ...(o.extra ?? {}),
});
const mkOsc = (o = {}) => ({ ceilingCompliance: { byAccountClass: {
  desk: [{ structure: STRUCT, n: (o.deskN ?? 3) + (o.deskUngatedN ?? 0), gatedArchetypes: [ARCHETYPE], gated: { n: o.deskN ?? 3, countAboveCeiling: o.deskOver ?? 0, maxSpreadPct: o.deskMax ?? 0.09, countBelowMinBid: o.deskThin ?? 0 }, ungated: { n: o.deskUngatedN ?? 0, countAboveCeiling: o.deskUngatedOver ?? 0 } },
         { structure: 'single_leg_rv', n: 87, gatedArchetypes: 'none', gated: { n: 0, countAboveCeiling: null, maxSpreadPct: null, countBelowMinBid: null }, ungated: { ...CONTROLS.negative } },
         { structure: 'single_leg_otm', n: 28, gatedArchetypes: 'all', gated: { ...CONTROLS.positive }, ungated: { n: 0 } }],
  fixture: [{ structure: STRUCT, n: o.fixN ?? 0, gatedArchetypes: [ARCHETYPE], gated: { n: o.fixN ?? 0 }, ungated: { n: 0 } }] } } });
const mkJ = rows => ({ rows });
const jrow = (o = {}) => ({ account: 'admin', structure: STRUCT, entryArchetype: ARCHETYPE, openTs: 2e12, entryBid: 0.65, entryAsk: 0.7, entryMarkUsd: 0.675, ...o });

// Default the harness to the VERIFIED-ABSENT build so the pre-existing cases keep testing what
// they were written to test; the build axis gets its own explicit cases below.
const OK_BUILD = { liveSha: '408f06a5', isAncestor: false };

function selfTest() {
  const g = (cag, osc, j, b = OK_BUILD) => grade({ r1: read1(cag), r2: read2(osc), r3: read3(j), build: readBuild(b) }).verdict;
  const gr = (cag, osc, j, b = OK_BUILD) => grade({ r1: read1(cag), r2: read2(osc), r3: read3(j), build: readBuild(b) });
  const cases = [
    ['clean: telemetry + desk rows + READ 2 all clean', 'PASS', () => g(mkCag(), mkOsc(), mkJ([jrow(), jrow(), jrow()]))],
    ['THE FALSE PASS: maxAdmittedSpreadPct null (null <= 0.10 is TRUE in JS)', 'VOID', () => g(mkCag({ maxAdmitted: null }), mkOsc({ deskN: 0 }), mkJ([]))],
    ['row ABSENT -> VOID (undefined, not 0)', 'VOID', () => g(mkCag({ absent: true }), mkOsc(), mkJ([jrow()]))],
    ['evaluated == 0 -> VOID', 'VOID', () => g(mkCag({ evaluated: 0 }), mkOsc({ deskN: 0 }), mkJ([]))],
    ['DISARMED -> VOID even with clean numbers', 'VOID', () => g(mkCag({ armed: false }), mkOsc(), mkJ([jrow()]))],
    ['breach beats VOID: over-ceiling admit while DISARMED', 'FAIL', () => g(mkCag({ armed: false, maxAdmitted: 0.4 }), mkOsc(), mkJ([jrow()]))],
    ['breach beats NOT_GRADED_YET: pooled breach, desk n=0', 'FAIL', () => g(mkCag({ maxAdmitted: 0.4 }), mkOsc({ deskN: 0, fixN: 9 }), mkJ([]))],
    ['fixture-driven -> NOT_GRADED_YET, never PASS', 'NOT_GRADED_YET', () => g(mkCag({ evaluated: 40 }), mkOsc({ deskN: 0, fixN: 9 }), mkJ([]))],
    ['journal N == 0 -> NOT_GRADED_YET', 'NOT_GRADED_YET', () => g(mkCag(), mkOsc(), mkJ([]))],
    ['journal breach -> FAIL', 'FAIL', () => g(mkCag(), mkOsc(), mkJ([jrow({ entryBid: 0.5, entryAsk: 0.7, entryMarkUsd: 0.6 })]))],
    ['MIN-BID axis alone -> FAIL', 'FAIL', () => g(mkCag(), mkOsc(), mkJ([jrow({ entryBid: 0.04, entryAsk: 0.05, entryMarkUsd: 0.045 })]))],
    ['N > 0 while evaluated == 0 -> FAIL (gate off the path)', 'FAIL', () => g(mkCag({ evaluated: 0 }), mkOsc(), mkJ([jrow()]))],
    ['TRA-2355 shipped mid-grade -> VOID', 'VOID', () => g(mkCag({ extra: { accountClass: 'desk' } }), mkOsc(), mkJ([jrow(), jrow(), jrow()]))],
    // The 87 pre-fix desk rows are archetype=directional / structure=single_leg_rv and 63 breach
    // 0.10. Dropping the structure axis pulls them in and manufactures a false FAIL of TRA-2295.
    // Telemetry is left healthy-but-idle here so the exclusion is what decides the verdict.
    ['pre-cutover rows excluded by the 3-part AND (no false FAIL)', 'NOT_GRADED_YET', () => g(mkCag(), mkOsc({ deskN: 0 }), mkJ(Array.from({ length: 87 }, () => jrow({ structure: 'single_leg_rv', entryBid: 0.02, entryAsk: 0.5, entryMarkUsd: 0.26 }))))],
    ['fixture rows excluded from the desk basis', 'NOT_GRADED_YET', () => g(mkCag(), mkOsc(), mkJ([jrow({ account: 'qa_mirror_1578_38096', entryBid: 0.5, entryAsk: 0.7, entryMarkUsd: 0.6 })]))],
    ['a MOVED pinned control halts the grade', 'VOID', () => { const o = mkOsc(); o.ceilingCompliance.byAccountClass.desk[1].ungated.countAboveCeiling = 62; return g(mkCag(), o, mkJ([jrow(), jrow(), jrow()])); }],

    // ── the build axis (added 2026-07-26) ───────────────────────────────────
    // The payload detector tests a key name I guessed. These prove the grade does not depend on
    // having guessed right.
    ['TRA-2355 live under an UNGUESSED key name -> still VOID, via commit ancestry',
      'VOID', () => g(mkCag(), mkOsc(), mkJ([jrow(), jrow(), jrow()]), { liveSha: 'deadbee', isAncestor: true })],
    ['build identity UNKNOWN suppresses a PASS -> NOT_GRADED_YET',
      'NOT_GRADED_YET', () => g(mkCag(), mkOsc(), mkJ([jrow(), jrow(), jrow()]), { liveSha: null, isAncestor: null })],
    ['build identity UNKNOWN does NOT suppress a FAIL',
      'FAIL', () => g(mkCag({ maxAdmitted: 0.4 }), mkOsc(), mkJ([jrow()]), { liveSha: null, isAncestor: null })],
    ['build identity UNKNOWN does NOT suppress a VOID',
      'VOID', () => g(mkCag({ armed: false }), mkOsc(), mkJ([jrow()]), { liveSha: null, isAncestor: null })],
    // The widened payload detector: any `account` substring, not the two names I predicted.
    ['account axis under an unpredicted payload key -> VOID (widened detector)',
      'VOID', () => g(mkCag({ extra: { spreadCeilingPerAccount: {} } }), mkOsc(), mkJ([jrow(), jrow(), jrow()]))],
    // The absent branch must SPEAK. A silent absence reads like "checked, fine".
    ['the ABSENT account axis is stated in REPORT, not silent', 'yes', () => {
      const out = gr(mkCag(), mkOsc(), mkJ([jrow(), jrow(), jrow()]));
      return out.report.some(m => m.startsWith('BASIS: READ 1 carries NO account axis')) &&
             out.report.some(m => m.includes('comparisonBasis')) ? 'yes' : 'MISSING';
    }],
    ['...and is NOT emitted once the axis is live (no contradictory basis)', 'yes', () => {
      const out = gr(mkCag({ extra: { accountClass: 'desk' } }), mkOsc(), mkJ([jrow()]));
      return out.report.some(m => m.startsWith('BASIS: READ 1 carries NO account axis')) ? 'LEAKED' : 'yes';
    }],

    // ── the STRUCTURE-KEY axis (added 2026-07-26, TRA-2345) ─────────────────
    // This script holds a THIRD copy of `DIRECTIONAL_STRUCTURE_LABEL`. TRA-2345 could not reach
    // it, so the divergence it closed server-side is closed HERE by assertion instead.
    ['structure key RENAMED under the grade -> VOID, not a quiet session',
      'VOID', () => g(mkCag({ publishedKey: 'demo_directional_v2' }), mkOsc(), mkJ([jrow(), jrow(), jrow()]))],
    // The whole reason the check parses a token instead of calling startsWith(): a SUFFIX rename
    // satisfies startsWith(STRUCT) and would read IDENTICALLY to a matching key.
    ['a SUFFIX rename is still caught (startsWith would read it as a match)',
      'VOID', () => g(mkCag({ publishedKey: `${STRUCT}_v2` }), mkOsc(), mkJ([jrow(), jrow(), jrow()]))],
    ['key divergence does NOT suppress a breach',
      'FAIL', () => g(mkCag({ publishedKey: `${STRUCT}_v2`, maxAdmitted: 0.4 }), mkOsc(), mkJ([jrow()]))],
    // Absence is a doc field going missing, NOT proof the key moved: PASS direction only.
    ['published key ABSENT suppresses a PASS -> NOT_GRADED_YET',
      'NOT_GRADED_YET', () => g(mkCag({ noKeys: true }), mkOsc(), mkJ([jrow(), jrow(), jrow()]))],
    ['published key ABSENT does NOT suppress a FAIL',
      'FAIL', () => g(mkCag({ noKeys: true, maxAdmitted: 0.4 }), mkOsc(), mkJ([jrow()]))],
    ['published key ABSENT does NOT suppress a VOID',
      'VOID', () => g(mkCag({ noKeys: true, armed: false }), mkOsc(), mkJ([jrow()]))],
    // The live field is `<key> — <prose>`, so the parse must survive the trailing sentence.
    ['the live-shaped `<key> — <prose>` value parses as a MATCH (no spurious VOID)', 'yes', () => {
      const out = gr(mkCag({ extra: { spreadCeilingStructureKeys: { demo_directional: `${STRUCT} — NOT the \`directional\` row, which carries only the cost bar and the delta ceiling and will always show spreadCeilingEvaluated 0 (TRA-2295).` } } }), mkOsc(), mkJ([jrow(), jrow(), jrow()]));
      return out.verdict === 'PASS' && !out.voids.length ? 'yes' : `${out.verdict}:${out.voids.join('|')}`;
    }],
  ];
  let bad = 0;
  for (const [name, want, fn] of cases) {
    let got; try { got = fn(); } catch (e) { got = `THREW ${e.message}`; }
    const ok = got === want;
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(got).padEnd(15)} (want ${String(want).padEnd(15)}) ${name}`);
  }
  console.log(`\n${cases.length - bad}/${cases.length} passed`);

  // The case COUNT is pinned in prose in two places that this file cannot edit: the TRA-2306
  // issue description and routine `0bb90f24` (the copy that FIRES). Both said `16/16` while this
  // suite stood at 30 — and the routine's own rule is "if the checker and this routine DISAGREE,
  // THAT DISAGREEMENT IS THE FINDING". So a grader who dutifully runs --self-test on Monday reads
  // a number that does not match its pin and burns the grade window publishing a non-finding.
  //
  // Fix the direction, not the number. GROWTH is expected and is never a finding; a DECREASE means
  // branches were deleted, and that is the one direction worth failing on. Assert the floor here so
  // the guarantee lives in the code instead of in two prose copies that drift independently.
  const FLOOR = 30; // raise only when adding cases; never lower to make a red suite green
  if (cases.length < FLOOR) {
    console.log(
      `\nSELF-TEST FLOOR BREACHED: ${cases.length} cases < floor ${FLOOR} — branches were REMOVED. ` +
      `A shrunken suite still prints "N/N passed" and reads exactly like a healthy one.`);
    return 1;
  }
  console.log(
    `case count ${cases.length} (floor ${FLOOR}) — the count is EXPECTED TO GROW. A number above ` +
    `the floor is NOT an instrument change and NOT a checker/routine disagreement; only a ` +
    `non-zero exit or a count BELOW the floor is a finding.`);
  return bad === 0 ? 0 : 1;
}

// ── main ─────────────────────────────────────────────────────────────────────
async function fetchJson(path, file) {
  const r = await fetch(`${HOST}${path}`, { signal: AbortSignal.timeout(90_000) });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  const j = await r.json();
  if (file) writeFileSync(file, JSON.stringify(j));
  return j;
}

const argv = process.argv.slice(2);
const arg = k => argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');

if (argv.includes('--self-test')) process.exit(selfTest());

const dir = arg('dir');
const sinceTs = arg('since') ? Date.parse(arg('since')) : undefined;
try {
  const [cag, osc, journal] = dir
    ? ['.2306-cag-now.json', '.2306-osc-now.json', '.2306-journal-now.json'].map(f => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')))
    : await Promise.all([
        fetchJson('/api/health/cost-aware-gate', '.2306-cag-now.json'),
        fetchJson('/api/health/option-spread-cost?rows=all', '.2306-osc-now.json'),
        fetchJson('/api/health/option-journal?rows=all', '.2306-journal-now.json'),
      ]);
  let liveSha = null;
  if (!dir) {
    const v = await fetchJson('/api/health/version');
    liveSha = v.commit ?? null;
    console.log(`live SHA ${v.commit} · startedAt ${v.startedAt}\n`);
  }
  const build = readBuild({ liveSha, isAncestor: tra2355IsLive(liveSha) });
  const r1 = read1(cag), r2 = read2(osc), r3 = read3(journal, sinceTs);
  console.log(`BUILD   liveSha=${build.liveSha ?? 'n/a'} TRA-2355(${TRA2355_COMMIT})=${build.tra2355 === null ? 'UNKNOWN' : build.tra2355 ? 'LIVE' : 'absent'} · READ 1 accountAxis=${r1.accountAxis ? 'PRESENT' : 'absent'}`);
  console.log(`KEY     grading \`${STRUCT}\` · payload publishes \`${r1.publishedKey ?? '(field absent)'}\` -> ${r1.keyDiverged ? 'DIVERGED' : r1.keyUnverified ? 'UNVERIFIED' : 'MATCH'} (TRA-2345)`);
  console.log(`READ 1  armed=${r1.armed} present=${r1.present} evaluated=${r1.evaluated} maxAdmitted=${r1.maxAdmitted === null ? 'null' : r1.maxAdmitted}`);
  console.log(`READ 2  desk.gated n=${r2.desk?.n ?? 0} over=${r2.desk?.countAboveCeiling} max=${r2.desk?.maxSpreadPct} thin=${r2.desk?.countBelowMinBid} · fixture.gated n=${r2.fixture?.n ?? 0} · controls=${r2.controls}`);
  console.log(`READ 3  desk N=${r3.n} over=${r3.over} thinBid=${r3.thinBid} worst=${r3.worst} noQuote=${r3.noQuote}`);
  const g = grade({ r1, r2, r3, build });
  console.log(`\nVERDICT: ${g.verdict}`);
  for (const [label, list] of [['FAIL', g.fails], ['VOID', g.voids], ['DEFER', g.defers], ['REPORT', g.report]]) {
    for (const m of list) console.log(`  [${label}] ${m}`);
  }
  process.exit(g.exit);
} catch (e) {
  console.error(`\nVERDICT: BLIND — ${e.message}`);
  console.error('BLIND is never a PASS. Re-probe; a 502 on every route is a deploy swap in flight.');
  process.exit(4);
}
