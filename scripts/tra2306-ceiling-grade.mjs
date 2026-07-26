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

// ── READ 1: /api/health/cost-aware-gate ──────────────────────────────────────
export function read1(cag) {
  const out = { armed: cag?.spreadCeiling?.armed, evaluated: null, maxAdmitted: undefined, present: false, instrumentChanged: false, notes: [] };

  // TRA-2355 free deploy detector. The account axis is ABSENT from the build under test
  // (verified live 2026-07-26: the substring `account` does not occur anywhere in this payload).
  // If it appears, TRA-2355 shipped and re-keyed the tally MID-GRADE: pre-2355 records hydrate
  // as `unattributed`, never `desk`. That is an instrument change, not a data change.
  const blob = JSON.stringify(cag ?? {});
  if (/accountClass|spreadCeilingByAccountClass/.test(blob)) {
    out.instrumentChanged = true;
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
export function grade({ r1, r2, r3 }) {
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
  report.push(...r2.notes, ...r1.notes, ...r3.notes);

  // ── STEP 2: VOID — explicitly NOT a pass.
  if (r1.armed === false) voids.push('spreadCeiling.armed === false — DISARMED, grade meaningless, re-open');
  if (r1.instrumentChanged) voids.push('the instrument was re-keyed under the grade (TRA-2355 live)');
  if (!r1.present) voids.push(`retained.byStructure[${STRUCT}] absent — the gate did not run`);
  else if (r1.evaluated === 0) voids.push('spreadCeilingEvaluated == 0 — the gate did not run');
  else if (r1.maxAdmitted === null) voids.push('spreadCeilingEvaluated > 0 but admitted NOTHING (maxAdmittedSpreadPct null) — ENFORCED / NO ADMITS, row-level claim VOID, not PASS');
  if (r2.controls === 'MOVED') voids.push('a pinned control MOVED — the instrument changed, do not grade');

  // ── STEP 3: NOT GRADED YET. READ 1 is ACCOUNT-BLIND, so it can VOID and can FAIL on its own,
  // but it can NEVER carry a PASS alone. No PASS is reachable while the desk row count is zero.
  const deskN = r2.desk?.n ?? 0;
  if (r3.n === 0) defers.push('journal N == 0 — NOT EVIDENCE');
  if (deskN === 0) {
    defers.push(`READ 2 desk[${STRUCT}].gated.n == 0`);
    if ((r2.fixture?.n ?? 0) > 0) defers.push(`fixture-driven: desk.gated.n == 0 while fixture.gated.n == ${r2.fixture.n} — READ 1's non-zero evaluated count is NOT the desk`);
  }

  const verdict = fails.length ? 'FAIL' : voids.length ? 'VOID' : defers.length ? 'NOT_GRADED_YET' : 'PASS';
  return { verdict, fails, voids, defers, report, exit: { FAIL: 1, VOID: 2, NOT_GRADED_YET: 3, PASS: 0 }[verdict] };
}

// ── self-test ────────────────────────────────────────────────────────────────
const mkCag = (o = {}) => ({ spreadCeiling: { armed: o.armed ?? true }, retained: { byStructure: o.absent ? [{ structure: 'directional' }] : [{ structure: STRUCT, spreadCeilingEvaluated: o.evaluated ?? 5, maxAdmittedSpreadPct: 'maxAdmitted' in o ? o.maxAdmitted : 0.08 }] }, ...(o.extra ?? {}) });
const mkOsc = (o = {}) => ({ ceilingCompliance: { byAccountClass: {
  desk: [{ structure: STRUCT, n: (o.deskN ?? 3) + (o.deskUngatedN ?? 0), gatedArchetypes: [ARCHETYPE], gated: { n: o.deskN ?? 3, countAboveCeiling: o.deskOver ?? 0, maxSpreadPct: o.deskMax ?? 0.09, countBelowMinBid: o.deskThin ?? 0 }, ungated: { n: o.deskUngatedN ?? 0, countAboveCeiling: o.deskUngatedOver ?? 0 } },
         { structure: 'single_leg_rv', n: 87, gatedArchetypes: 'none', gated: { n: 0, countAboveCeiling: null, maxSpreadPct: null, countBelowMinBid: null }, ungated: { ...CONTROLS.negative } },
         { structure: 'single_leg_otm', n: 28, gatedArchetypes: 'all', gated: { ...CONTROLS.positive }, ungated: { n: 0 } }],
  fixture: [{ structure: STRUCT, n: o.fixN ?? 0, gatedArchetypes: [ARCHETYPE], gated: { n: o.fixN ?? 0 }, ungated: { n: 0 } }] } } });
const mkJ = rows => ({ rows });
const jrow = (o = {}) => ({ account: 'admin', structure: STRUCT, entryArchetype: ARCHETYPE, openTs: 2e12, entryBid: 0.65, entryAsk: 0.7, entryMarkUsd: 0.675, ...o });

function selfTest() {
  const g = (cag, osc, j) => grade({ r1: read1(cag), r2: read2(osc), r3: read3(j) }).verdict;
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
  ];
  let bad = 0;
  for (const [name, want, fn] of cases) {
    let got; try { got = fn(); } catch (e) { got = `THREW ${e.message}`; }
    const ok = got === want;
    if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(got).padEnd(15)} (want ${String(want).padEnd(15)}) ${name}`);
  }
  console.log(`\n${cases.length - bad}/${cases.length} passed`);
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
  if (!dir) {
    const v = await fetchJson('/api/health/version');
    console.log(`live SHA ${v.commit} · startedAt ${v.startedAt}\n`);
  }
  const r1 = read1(cag), r2 = read2(osc), r3 = read3(journal, sinceTs);
  console.log(`READ 1  armed=${r1.armed} present=${r1.present} evaluated=${r1.evaluated} maxAdmitted=${r1.maxAdmitted === null ? 'null' : r1.maxAdmitted}`);
  console.log(`READ 2  desk.gated n=${r2.desk?.n ?? 0} over=${r2.desk?.countAboveCeiling} max=${r2.desk?.maxSpreadPct} thin=${r2.desk?.countBelowMinBid} · fixture.gated n=${r2.fixture?.n ?? 0} · controls=${r2.controls}`);
  console.log(`READ 3  desk N=${r3.n} over=${r3.over} thinBid=${r3.thinBid} worst=${r3.worst} noQuote=${r3.noQuote}`);
  const g = grade({ r1, r2, r3 });
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
