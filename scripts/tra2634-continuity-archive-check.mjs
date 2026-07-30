// TRA-2634 — grade the level-continuity detector against the REAL stored report
// archive, on every fold, and print the cross-tab against the deployed r>=2
// session-move rule.
//
// Ship a checker, never a dated green. The numbers in TRA-2634's comment thread
// were measured by this script; re-running it is how anyone confirms they still
// hold, and how the Quant grades the detector against the FGMC / FLYYQ series
// they offered as a fixture.
//
// WHAT IT ASSERTS (both directions, every run — a one-directional control is
// half a control):
//
//   KNOWN-BAD  every row in `MUST_FIRE` must come back `suspect`, and the ones
//              marked `newCatch` must ALSO be passed by the deployed r>=2 rule —
//              otherwise the "new instrument" is measuring nothing.
//   KNOWN-GOOD every row in `MUST_NOT_FIRE` must come back `consistent`. These
//              include the two rows that make the disagreement concrete (FLYYQ
//              `0.01 -> 0.02 / +100%`, r = 2.000 exactly, which the SESSION rule
//              flags and this one passes) and NVTS, the worst healthy pair.
//   BAND       the healthy population must stay below the tolerance and the
//              offender population above it, i.e. the empty band the threshold
//              was derived inside must still be empty.
//
// Exit: 0 PASS · 1 a control failed · 3 BLIND (nothing readable / no gradeable
// pair). ⛔ 3 IS A HOLD, NOT A PASS — a zero pair count is a fact about the
// fetch, never about the archive.
//
// Usage:
//   HOST=https://tradingai-bqb1.onrender.com node scripts/tra2634-continuity-archive-check.mjs
//   HOST=http://localhost:4242 ANCHOR=2026-07-30 DAYS=100 node scripts/...
//
// Reads `ADMIN_USERNAME` / `ADMIN_PASSWORD` from `.env`. bqb1 auth is a BEARER
// TOKEN, not a cookie: `POST /api/auth/login` 200s and sets no cookie, so a
// `curl -b jar` reads 401 on every data route and looks like a permissions
// problem.
//
// ⛔ Run `pnpm --filter @trading-app/shared build` FIRST. This imports the BUILT
// bytes from `packages/shared/dist`, and a stale-but-present symbol would grade
// last week's logic and print a confident number.
import fs from 'node:fs';
import {
  assessQuotePlausibility,
  assessLevelContinuity,
  CONTINUITY_RESIDUAL_TOLERANCE,
  SUSPECT_MOVE_RATIO,
} from '../packages/shared/dist/index.js';

const HOST = process.env.HOST ?? 'https://tradingai-bqb1.onrender.com';
const FOLDS = ['demo', 'live', 'sandbox'];
const DAYS = Number(process.env.DAYS ?? 100);
// A fixed anchor, passed in — never `new Date()`. A default window is an argument
// you did not pass, and "no data" from a window in the future is not evidence.
const ANCHOR = process.env.ANCHOR ?? '2026-07-30';

// ── NYSE calendar. Adjacency is the precondition, not a nicety: over a gap the
// comparison becomes a multi-day move and the residual stops meaning anything.
const HOLIDAYS = new Set([
  '2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26',
  '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
]);
function isMarketDayIso(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || HOLIDAYS.has(d)) return false;
  const [y, m, dd] = d.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
  return dow !== 0 && dow !== 6;
}
function previousMarketDayIso(d, maxLookbackDays = 10) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const [y, m, dd] = d.split('-').map(Number);
  let t = Date.UTC(y, m - 1, dd);
  for (let i = 0; i < maxLookbackDays; i++) {
    t -= 86400000;
    const iso = new Date(t).toISOString().slice(0, 10);
    if (isMarketDayIso(iso)) return iso;
  }
  return null;
}

// ── The control sets. Every row is verbatim from the archive, and the offenders
// and known-goods come from the SAME population — a control set written only in
// my own dialect proves nothing but that the grader agrees with itself.
//
// ⛔ EACH ROW IS SCOPED TO THE BOX IT WAS MEASURED ON, and the checker grades
// only the rows belonging to `HOST`. The two boxes hold DIFFERENT archives and
// the first revision of this script asserted them as one set — it failed 5
// controls on bqb1 for rows that live on localhost, which reads exactly like a
// broken detector. Do not let one box's read stand in for the other's.
//
// ⭐ And the same (symbol, dates) can carry OPPOSITE verdicts on the two boxes,
// for a reason worth knowing: bqb1 stored CRNX as `98.74` on both days (2 dp, so
// a REPUBLICATION and correctly ungradeable) while localhost stored `98.739` ->
// `98.64382583868664` (full precision, a real discontinuity at r = 1.9874, which
// the session rule passes). Rounding a published field can erase a defect from
// the record — the artifact is only as gradeable as its precision.
const key = (sym, priorDate, date) => `${sym}|${priorDate}->${date}`;
const BQB1 = 'bqb1';
const LOCAL = 'localhost';
const box = HOST.includes('localhost') || HOST.includes('127.0.0.1') ? LOCAL : BQB1;

/** Offenders. `newCatch` = the deployed r>=2 rule PASSES this row and ranked it anyway. */
const MUST_FIRE = [
  // bqb1 — demo + live folds
  { box: BQB1, k: key('FLYYQ', '2026-07-16', '2026-07-17'), newCatch: true, residual: 1.3334 },
  { box: BQB1, k: key('VEEE', '2026-07-15', '2026-07-16'), newCatch: true, residual: 1.448329 },
  { box: BQB1, k: key('TDIC', '2026-06-17', '2026-06-18'), newCatch: true, residual: 1.025008 },
  { box: BQB1, k: key('SDOT', '2026-06-23', '2026-06-24'), newCatch: false, residual: 1.496775 },
  { box: BQB1, k: key('JEM', '2026-07-13', '2026-07-14'), newCatch: false, residual: 1.075306 },
  // localhost — where the FGMC files TRA-2610 was filed on actually live
  { box: LOCAL, k: key('FGMC', '2026-07-28', '2026-07-29'), newCatch: false, residual: 2.106599 },
  { box: LOCAL, k: key('CRNX', '2026-07-07', '2026-07-08'), newCatch: true, residual: 1.987390 },
  { box: LOCAL, k: key('ABTC', '2026-07-07', '2026-07-08'), newCatch: true, residual: 1.302147 },
  { box: LOCAL, k: key('000660.KS', '2026-07-13', '2026-07-14'), newCatch: true, residual: 1.036856 },
  { box: LOCAL, k: key('SDOT', '2026-07-07', '2026-07-08'), newCatch: false, residual: 1.219750 },
];

/** Known-good: real adjacent pairs continuous with our own published close. */
const MUST_NOT_FIRE = [
  // r = 2.000 EXACTLY: the session rule fires on this row and this one must not.
  { box: BQB1, k: key('FLYYQ', '2026-07-23', '2026-07-24') },
  { box: BQB1, k: key('VRAX', '2026-07-10', '2026-07-13') },
  { box: BQB1, k: key('DFNS', '2026-07-28', '2026-07-29') },  // an earlier checker falsely condemned this
  { box: BQB1, k: key('HTCO', '2026-05-11', '2026-05-12') },
  { box: BQB1, k: key('TDIC', '2026-06-15', '2026-06-16') },
  { box: BQB1, k: key('INLF', '2026-07-01', '2026-07-02') },
  { box: BQB1, k: key('ATLN', '2026-06-23', '2026-06-24') },
  // The worst healthy pair measured anywhere, 1.005543 — it is what sizes the
  // headroom, and it is most likely a stale prior snapshot ($30.84 published vs
  // $30.67 implied). If this one ever flips, the tolerance is too tight.
  { box: LOCAL, k: key('NVTS', '2026-06-03', '2026-06-04') },
  { box: LOCAL, k: key('IONS', '2026-07-09', '2026-07-10') },
  { box: LOCAL, k: key('CLRO', '2026-07-10', '2026-07-13') },
  { box: LOCAL, k: key('JLHL', '2026-07-16', '2026-07-17') },
  { box: LOCAL, k: key('SPCE', '2026-06-01', '2026-06-02') },
  { box: LOCAL, k: key('PRFX', '2026-05-29', '2026-06-01') },
];

// ── Fetch.
const env = Object.fromEntries(
  fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const login = await fetch(`${HOST}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: env.ADMIN_USERNAME ?? 'admin', password: env.ADMIN_PASSWORD }),
});
if (!login.ok) {
  console.error(`login ${login.status} on ${HOST} — BLIND (this is a HOLD, not a pass)`);
  process.exit(3);
}
const H = { Authorization: `Bearer ${(await login.json()).token}` };

const dates = [];
const base = new Date(`${ANCHOR}T12:00:00Z`).getTime();
for (let i = 0; i < DAYS; i++) dates.push(new Date(base - i * 86400000).toISOString().slice(0, 10));

let unreadable = 0;
const tables = new Map();          // fold -> date -> Map(symbol -> row)
for (const fold of FOLDS) {
  const byDate = new Map();
  for (const date of dates) {
    const r = await fetch(`${HOST}/api/reports/${date}?mode=${fold}`, { headers: H });
    if (r.status === 404) continue;                       // a real negative
    const text = await r.text();
    if (!r.ok) { unreadable++; continue; }                // NOT a zero
    let rep;
    try { rep = JSON.parse(text); } catch { unreadable++; continue; }
    const movers = rep?.top5Movers ?? [];
    if (movers.length === 0) continue;
    byDate.set(date, new Map(movers.map((m, i) => [String(m.symbol).toUpperCase(),
      { price: m.price, changePct: m.changePct, rank: i + 1 }])));
  }
  tables.set(fold, byDate);
}

// ── Grade every adjacent-session pair.
const pairs = [];
for (const [fold, byDate] of tables) {
  for (const [date, today] of byDate) {
    const pd = previousMarketDayIso(date);
    const prior = pd === null ? null : byDate.get(pd);
    for (const [sym, cur] of today) {
      const p = prior?.get(sym) ?? null;
      const v = assessLevelContinuity(p, cur);
      const s = assessQuotePlausibility({ price: cur.price, changePct: cur.changePct });
      pairs.push({ fold, date, priorDate: pd, sym, rank: cur.rank, cur, prior: p,
        verdict: v.verdict, reason: v.reason, residual: v.residual,
        impliedPrevClose: v.impliedPrevClose,
        deployedSuspect: s.suspect, sessionRatio: s.ratio,
        k: key(sym, pd ?? 'none', date) });
    }
  }
}
const graded = pairs.filter(p => p.verdict !== 'abstain');
if (graded.length === 0) {
  console.error(`no gradeable adjacent-session pair over ${DAYS}d on ${HOST}`
    + ` (rows=${pairs.length}, unreadable=${unreadable}) — BLIND (this is a HOLD, not a pass)`);
  process.exit(3);
}

const suspects = graded.filter(p => p.verdict === 'suspect');
const healthy = graded.filter(p => p.verdict === 'consistent');
const abstains = pairs.filter(p => p.verdict === 'abstain');
const reasons = {};
for (const a of abstains) reasons[a.reason ?? '?'] = (reasons[a.reason ?? '?'] ?? 0) + 1;

console.log(`HOST ${HOST}  anchor ${ANCHOR}  window ${DAYS}d  unreadable ${unreadable}`);
console.log(`mover rows ${pairs.length} | GRADED ${graded.length}`
  + ` (suspect ${suspects.length}, consistent ${healthy.length})`
  + ` | ABSTAINED ${abstains.length} ${JSON.stringify(reasons)}`);
console.log(`tolerance ${CONTINUITY_RESIDUAL_TOLERANCE} | session rule r>=${SUSPECT_MOVE_RATIO}`);

// ⭐ Reachability first. A verdict of "0 offenders" is only meaningful if both
// branches could have fired on this population.
const fails = [];
if (suspects.length === 0) fails.push('BLIND: no row reached the suspect branch');
if (healthy.length === 0) fails.push('BLIND: no row reached the consistent branch');

const newCatches = suspects.filter(p => !p.deployedSuspect);
console.log(`\nrows this instrument catches that r>=${SUSPECT_MOVE_RATIO} PASSES: ${newCatches.length}`);
for (const p of newCatches.sort((a, b) => b.residual - a.residual)) {
  console.log(`  ${p.sym}\t${p.fold}\t${p.priorDate}->${p.date}\t#${p.rank}`
    + `\tprior=${p.prior.price}/${p.prior.changePct}\ttoday=${p.cur.price}/${p.cur.changePct}`
    + `\timpliedPrev=${p.impliedPrevClose.toFixed(4)}\tresidual=${p.residual.toFixed(6)}`
    + `\tsessionR=${p.sessionRatio === null ? 'n/a' : p.sessionRatio.toFixed(4)}`);
}
// The mirror direction, printed because neither rule is a superset of the other.
const sessionOnly = graded.filter(p => p.deployedSuspect && p.verdict === 'consistent');
console.log(`rows r>=${SUSPECT_MOVE_RATIO} catches that this one calls CONSISTENT: ${sessionOnly.length}`
  + ` (${sessionOnly.map(p => `${p.sym} ${p.date}`).join(', ') || 'none'})`);

// ── KNOWN-BAD control, scoped to this box.
const byKey = new Map(pairs.map(p => [p.k, p]));
const mustFire = MUST_FIRE.filter(r => r.box === box);
const mustNotFire = MUST_NOT_FIRE.filter(r => r.box === box);
console.log(`\ncontrols for box "${box}": ${mustFire.length} known-bad, ${mustNotFire.length} known-good`
  + ` (${MUST_FIRE.length - mustFire.length + MUST_NOT_FIRE.length - mustNotFire.length} belong to the other box`
  + ` and are NOT graded here — run both hosts)`);
// ⭐ A control set that shrank to nothing would make every green vacuous.
if (mustFire.length === 0 || mustNotFire.length === 0) {
  fails.push(`BLIND: box "${box}" has no control set on one side`
    + ` (known-bad ${mustFire.length}, known-good ${mustNotFire.length})`);
}
for (const { k, newCatch, residual } of mustFire) {
  const p = byKey.get(k);
  if (!p) { fails.push(`KNOWN-BAD ${k}: pair ABSENT from this box's archive (fold/window?) — cannot grade`); continue; }
  if (p.verdict !== 'suspect') fails.push(`KNOWN-BAD ${k}: verdict ${p.verdict} (${p.reason ?? '-'}), expected suspect`);
  if (p.residual !== null && Math.abs(p.residual - residual) > 1e-4) {
    fails.push(`KNOWN-BAD ${k}: residual ${p.residual} != pinned ${residual}`);
  }
  // The leg that stops this being a restatement of TRA-2379.
  if (newCatch && p.deployedSuspect) {
    fails.push(`KNOWN-BAD ${k}: marked newCatch but the deployed r>=${SUSPECT_MOVE_RATIO} rule ALSO flags it`
      + ` — this row no longer measures what the new instrument adds`);
  }
}

// ── KNOWN-GOOD control. The half nobody runs, and the one that catches a blind
// gate wearing a discerning face.
for (const { k } of mustNotFire) {
  const p = byKey.get(k);
  if (!p) { fails.push(`KNOWN-GOOD ${k}: pair ABSENT from this box's archive — cannot grade`); continue; }
  if (p.verdict !== 'consistent') {
    fails.push(`KNOWN-GOOD ${k}: verdict ${p.verdict} (${p.reason ?? '-'}) residual ${p.residual}`
      + ` — a genuine mover continuous with our own close must NOT be flagged`);
  }
}

// ── BAND control: the empty band the threshold was derived inside.
const worstHealthy = healthy.reduce((m, p) => Math.max(m, p.residual), 0);
const tightestOffender = suspects.reduce((m, p) => Math.min(m, p.residual), Infinity);
console.log(`\nband: worst healthy ${worstHealthy.toFixed(6)}`
  + ` < tolerance ${CONTINUITY_RESIDUAL_TOLERANCE} <= tightest offender ${tightestOffender.toFixed(6)}`);
if (!(worstHealthy < CONTINUITY_RESIDUAL_TOLERANCE)) {
  fails.push(`BAND: a healthy pair reached ${worstHealthy} — the tolerance no longer separates the populations`);
}

if (fails.length > 0) {
  console.error(`\nFAIL — ${fails.length} control(s):`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\nPASS on box "${box}" — ${mustFire.length} known-bad fired, ${mustNotFire.length} known-good silent,`
  + ` both branches reachable, band intact.`);
console.log(`⚠️  This grades ONE box. The other box's control rows were skipped above; run both.`);
